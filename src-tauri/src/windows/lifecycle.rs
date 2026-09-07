use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    Hide,
    Exit,
    Restart,
    Relocate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Visible,
    PreparingHide,
    Hidden,
    PreparingExit,
    Exiting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Participant {
    pub label: String,
    pub registration: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Flush {
        generation: u64,
        intent: Intent,
        participant: Participant,
    },
    Release {
        generation: u64,
        participant: Participant,
    },
    HideMain {
        generation: u64,
    },
    ShowMain,
    Exit,
    Restart,
    Prepared {
        generation: u64,
    },
    ReportFailure {
        label: Option<String>,
    },
}

#[derive(Debug)]
struct Pending {
    generation: u64,
    intent: Intent,
    participants: BTreeMap<String, (u64, bool)>,
    deadline_ms: u64,
}

#[derive(Debug, Default)]
pub struct LifecycleCoordinator {
    phase: Phase,
    next_generation: u64,
    pending: Option<Pending>,
}

impl LifecycleCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn operation(&self) -> Option<(u64, Intent, u64)> {
        self.pending
            .as_ref()
            .map(|p| (p.generation, p.intent, p.deadline_ms))
    }

    pub fn request(
        &mut self,
        intent: Intent,
        participants: Vec<Participant>,
        now_ms: u64,
    ) -> Vec<Effect> {
        if self.phase == Phase::Exiting {
            return vec![];
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.intent != Intent::Hide && intent == Intent::Hide)
        {
            return vec![];
        }
        let mut snapshot = BTreeMap::new();
        for participant in participants {
            if intent == Intent::Hide && participant.label != "main" {
                continue;
            }
            if participant.registration == 0
                || snapshot
                    .insert(participant.label, (participant.registration, false))
                    .is_some()
            {
                return self.fail(None);
            }
        }
        if !snapshot.contains_key("main") {
            return self.fail(None);
        }
        let mut effects = vec![];
        if let Some(pending) = &self.pending {
            if pending.intent == intent || pending.intent != Intent::Hide {
                let unchanged = pending.participants.len() == snapshot.len()
                    && pending.participants.iter().all(|(label, (token, _))| {
                        snapshot.get(label).is_some_and(|(other, _)| token == other)
                    });
                return if unchanged { vec![] } else { self.fail(None) };
            }
            // Only escalation from reversible hiding can replace an active operation.
            effects.extend(self.cancel(pending.generation));
        }
        let Some(generation) = self.next_generation.checked_add(1) else {
            return self.fail(None);
        };
        self.next_generation = generation;
        for (label, (registration, _)) in &snapshot {
            effects.push(Effect::Flush {
                generation,
                intent,
                participant: Participant {
                    label: label.clone(),
                    registration: *registration,
                },
            });
        }
        self.phase = if intent == Intent::Hide {
            Phase::PreparingHide
        } else {
            Phase::PreparingExit
        };
        self.pending = Some(Pending {
            generation,
            intent,
            participants: snapshot,
            deadline_ms: now_ms.saturating_add(10_000),
        });
        effects
    }

    pub fn acknowledge(
        &mut self,
        generation: u64,
        participant: &Participant,
        saved: bool,
    ) -> Vec<Effect> {
        let Some(pending) = &mut self.pending else {
            return vec![];
        };
        if pending.generation != generation {
            return vec![];
        }
        let Some((token, acknowledged)) = pending.participants.get_mut(&participant.label) else {
            return vec![];
        };
        if *token != participant.registration || *acknowledged {
            return vec![];
        }
        if !saved {
            return self.fail(Some(participant.label.clone()));
        }
        *acknowledged = true;
        if pending.participants.values().any(|(_, saved)| !saved) {
            return vec![];
        }
        match pending.intent {
            Intent::Hide => vec![Effect::HideMain { generation }],
            Intent::Exit => {
                self.pending.take();
                self.phase = Phase::Exiting;
                vec![Effect::Exit]
            }
            Intent::Restart => {
                self.pending.take();
                self.phase = Phase::Exiting;
                vec![Effect::Restart]
            }
            Intent::Relocate => vec![Effect::Prepared { generation }],
        }
    }

    pub fn is_prepared_relocation(&self) -> bool {
        self.pending.as_ref().is_some_and(|pending| {
            pending.intent == Intent::Relocate
                && pending.participants.values().all(|(_, saved)| *saved)
        })
    }

    pub fn commit_prepared_relocation(&mut self) -> Vec<Effect> {
        if !self.is_prepared_relocation() {
            return vec![];
        }
        self.pending.take();
        self.phase = Phase::Exiting;
        vec![Effect::Restart]
    }

    /// Commits Hidden only after the platform window operation succeeds.
    pub fn confirm_hide(&mut self, generation: u64, succeeded: bool) -> Vec<Effect> {
        let valid = self.pending.as_ref().is_some_and(|pending| {
            pending.generation == generation
                && pending.intent == Intent::Hide
                && pending.participants.values().all(|(_, saved)| *saved)
        });
        if !valid {
            return vec![];
        }
        if !succeeded {
            return self.fail(None);
        }
        let pending = self
            .pending
            .take()
            .expect("matching hide operation was checked");
        self.phase = Phase::Hidden;
        releases(&pending)
    }

    pub fn cancel(&mut self, generation: u64) -> Vec<Effect> {
        if !self
            .pending
            .as_ref()
            .is_some_and(|p| p.generation == generation)
        {
            return vec![];
        }
        let pending = self.pending.take().expect("matching operation was checked");
        self.phase = Phase::Visible;
        let mut effects = releases(&pending);
        effects.push(Effect::ShowMain);
        effects
    }

    pub fn activate(&mut self) -> Vec<Effect> {
        let mut effects = vec![];
        if let Some(pending) = &self.pending {
            if pending.intent == Intent::Hide {
                effects.extend(self.cancel(pending.generation));
            }
        }
        if self.phase != Phase::Exiting {
            if self.pending.is_none() {
                self.phase = Phase::Visible;
            }
            effects.push(Effect::ShowMain);
        }
        effects
    }

    pub fn expire(&mut self, now_ms: u64) -> Vec<Effect> {
        if self.is_prepared_relocation() {
            return vec![];
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now_ms >= p.deadline_ms)
        {
            self.fail(None)
        } else {
            vec![]
        }
    }

    fn fail(&mut self, label: Option<String>) -> Vec<Effect> {
        let mut effects = self
            .pending
            .take()
            .map(|p| releases(&p))
            .unwrap_or_default();
        self.phase = Phase::Visible;
        effects.push(Effect::ShowMain);
        effects.push(Effect::ReportFailure { label });
        effects
    }
}

fn releases(pending: &Pending) -> Vec<Effect> {
    pending
        .participants
        .iter()
        .map(|(label, (registration, _))| Effect::Release {
            generation: pending.generation,
            participant: Participant {
                label: label.clone(),
                registration: *registration,
            },
        })
        .collect()
}
