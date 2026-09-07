use super::lifecycle::{Effect, Intent, LifecycleCoordinator, Participant, Phase};
use crate::error::CommandError;
use std::collections::BTreeMap;

#[derive(Debug)]
struct Registration {
    token: u64,
    issued: bool,
    ready: bool,
}

/// Reserves identities even before a webview has installed its listeners.
/// A live but unready editor must never disappear from the save snapshot.
#[derive(Debug, Default)]
pub struct LifecycleRegistry {
    core: LifecycleCoordinator,
    next_token: u64,
    registrations: BTreeMap<String, Registration>,
    awaiting: BTreeMap<String, Effect>,
}

impl LifecycleRegistry {
    pub fn phase(&self) -> Phase {
        self.core.phase()
    }
    pub fn operation(&self) -> Option<(u64, Intent, u64)> {
        self.core.operation()
    }

    fn reserve(&mut self, label: &str) -> Result<u64, CommandError> {
        self.next_token = self
            .next_token
            .checked_add(1)
            .ok_or_else(|| CommandError::conflict("lifecycle registration exhausted"))?;
        let token = self.next_token;
        self.registrations.insert(
            label.into(),
            Registration {
                token,
                issued: false,
                ready: false,
            },
        );
        Ok(token)
    }

    pub fn register(&mut self, label: &str) -> Result<(u64, Vec<Effect>), CommandError> {
        if let Some(registration) = self.registrations.get_mut(label) {
            if !registration.issued {
                registration.issued = true;
                return Ok((registration.token, vec![]));
            }
        }
        let effects = self.invalidate();
        let token = self.reserve(label)?;
        self.registrations
            .get_mut(label)
            .expect("reserved registration")
            .issued = true;
        Ok((token, effects))
    }

    pub fn set_ready(
        &mut self,
        label: &str,
        token: u64,
        ready: bool,
    ) -> Result<Vec<Effect>, CommandError> {
        let Some(registration) = self
            .registrations
            .get_mut(label)
            .filter(|r| r.token == token && r.issued)
        else {
            return if ready {
                Err(CommandError::conflict("lifecycle registration is stale"))
            } else {
                Ok(vec![])
            };
        };
        registration.ready = ready;
        if !ready {
            return Ok(self.invalidate());
        }
        Ok(self.awaiting.get(label).cloned().into_iter().collect())
    }

    fn participants(&mut self, labels: Vec<String>) -> Result<Vec<Participant>, CommandError> {
        labels
            .into_iter()
            .map(|label| {
                let registration = match self.registrations.get(&label) {
                    Some(r) => r.token,
                    None => self.reserve(&label)?,
                };
                Ok(Participant {
                    label,
                    registration,
                })
            })
            .collect()
    }

    pub fn request(
        &mut self,
        intent: Intent,
        labels: Vec<String>,
        now: u64,
    ) -> Result<Vec<Effect>, CommandError> {
        let participants = self.participants(labels)?;
        let effects = self.core.request(intent, participants, now);
        Ok(self.deliver(effects))
    }

    pub fn acknowledge(
        &mut self,
        generation: u64,
        label: &str,
        token: u64,
        saved: bool,
        labels: Vec<String>,
        now: u64,
    ) -> Result<Vec<Effect>, CommandError> {
        // Check the deadline here too: the OS can delay the one-shot timer.
        let expired = self.expire(now);
        if !expired.is_empty() {
            return Ok(expired);
        }
        if !self
            .registrations
            .get(label)
            .is_some_and(|r| r.token == token && r.ready)
        {
            return Ok(vec![]);
        }
        let mut effects = vec![];
        if let Some((active, intent, _)) = self.core.operation() {
            if active != generation {
                return Ok(vec![]);
            }
            let participants = self.participants(labels)?;
            effects.extend(self.core.request(intent, participants, now));
        }
        effects.extend(self.core.acknowledge(
            generation,
            &Participant {
                label: label.into(),
                registration: token,
            },
            saved,
        ));
        self.awaiting.remove(label);
        Ok(self.deliver(effects))
    }

    pub fn expire(&mut self, now: u64) -> Vec<Effect> {
        let effects = self.core.expire(now);
        self.deliver(effects)
    }

    pub fn confirm_hide(&mut self, generation: u64, succeeded: bool) -> Vec<Effect> {
        let effects = self.core.confirm_hide(generation, succeeded);
        self.deliver(effects)
    }

    pub fn is_prepared_relocation(&self) -> bool {
        self.core.is_prepared_relocation()
    }

    pub fn commit_prepared_relocation(&mut self) -> Vec<Effect> {
        let effects = self.core.commit_prepared_relocation();
        self.deliver(effects)
    }

    pub fn cancel(&mut self, generation: u64) -> Vec<Effect> {
        let effects = self.core.cancel(generation);
        self.deliver(effects)
    }

    pub fn activate(&mut self) -> Vec<Effect> {
        let effects = self.core.activate();
        self.deliver(effects)
    }

    pub fn invalidate(&mut self) -> Vec<Effect> {
        let Some((generation, _, _)) = self.core.operation() else {
            return vec![];
        };
        let mut effects = self.core.cancel(generation);
        effects.push(Effect::ReportFailure { label: None });
        self.deliver(effects)
    }

    fn deliver(&mut self, effects: Vec<Effect>) -> Vec<Effect> {
        let mut deliverable = vec![];
        for effect in effects {
            match &effect {
                Effect::Flush { participant, .. } => {
                    self.awaiting
                        .insert(participant.label.clone(), effect.clone());
                    if !self
                        .registrations
                        .get(&participant.label)
                        .is_some_and(|r| r.ready && r.token == participant.registration)
                    {
                        continue;
                    }
                }
                Effect::Release { participant, .. } => {
                    self.awaiting.remove(&participant.label);
                }
                Effect::Exit | Effect::Restart => self.awaiting.clear(),
                _ => {}
            }
            deliverable.push(effect);
        }
        deliverable
    }
}
