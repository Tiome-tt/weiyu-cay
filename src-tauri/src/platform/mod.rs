#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use crate::error::CommandError;

#[cfg(unix)]
pub use unix::{
    recover_file, replace_file, replace_file_with_backup, sync_parent, IndexMutationLock,
    SafeDirectory,
};
#[cfg(windows)]
pub use windows::{
    recover_file, replace_file, replace_file_with_backup, sync_parent, IndexMutationLock,
    SafeDirectory,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NewFilePublishState {
    Published,
    DestinationExists,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SafeEntryKind {
    Directory,
    RegularFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreateChildFailureState {
    DefinitelyNotCreated,
    CreatedRecoveryRequired,
}

#[derive(Debug)]
pub(crate) struct CreateChildFailure {
    state: CreateChildFailureState,
    error: CommandError,
}

impl CreateChildFailure {
    pub(crate) fn definitely_not_created(error: CommandError) -> Self {
        Self {
            state: CreateChildFailureState::DefinitelyNotCreated,
            error,
        }
    }

    pub(crate) fn created_recovery_required(error: CommandError) -> Self {
        Self {
            state: CreateChildFailureState::CreatedRecoveryRequired,
            error,
        }
    }

    pub(crate) fn state(&self) -> CreateChildFailureState {
        self.state
    }

    pub(crate) fn into_error(self) -> CommandError {
        self.error
    }
}
