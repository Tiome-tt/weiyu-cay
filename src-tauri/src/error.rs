use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandErrorCode {
    Validation,
    NotFound,
    Conflict,
    Io,
    Database,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: CommandErrorCode,
    message: String,
    #[serde(skip)]
    diagnostic: Option<String>,
}

impl CommandError {
    pub fn validation(diagnostic: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Validation, diagnostic)
    }

    pub fn not_found(diagnostic: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::NotFound, diagnostic)
    }

    pub fn conflict(diagnostic: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Conflict, diagnostic)
    }

    pub fn io(diagnostic: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Io, diagnostic)
    }

    pub fn database(diagnostic: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Database, diagnostic)
    }

    pub fn unsupported(diagnostic: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Unsupported, diagnostic)
    }

    pub fn code(&self) -> CommandErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn diagnostic(&self) -> Option<&str> {
        self.diagnostic.as_deref()
    }

    fn new(code: CommandErrorCode, diagnostic: impl Into<String>) -> Self {
        Self {
            code,
            message: safe_message(code).to_owned(),
            diagnostic: Some(diagnostic.into()),
        }
    }
}

impl PartialEq for CommandError {
    fn eq(&self, other: &Self) -> bool {
        self.code == other.code && self.message == other.message
    }
}

impl Eq for CommandError {}

fn safe_message(code: CommandErrorCode) -> &'static str {
    match code {
        CommandErrorCode::Validation => "The request is invalid.",
        CommandErrorCode::NotFound => "The requested item was not found.",
        CommandErrorCode::Conflict => "The request conflicts with the current state.",
        CommandErrorCode::Io => "The operation could not be completed on local storage.",
        CommandErrorCode::Database => "The local note index is unavailable.",
        CommandErrorCode::Unsupported => "This operation is not supported.",
    }
}
