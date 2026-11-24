use crate::prompt::PromptInfo;
use chrono::{DateTime, Utc};

/// One thing that happened in an agent session, either by the human or by the agent.
pub enum EventKind {
    /// The human sent a prompt. Only derived features are kept, never the text.
    Prompt(PromptInfo),
    /// The human stopped the agent mid-turn.
    Interrupt,
    /// The human ran a shell command themselves (e.g. `!npm test` in Claude Code).
    Shell,
    /// The human ran a slash command.
    Command,
    /// The human rejected a tool call the agent wanted to make.
    Rejected,
    /// The agent produced output or got a tool result back.
    Agent { tools: Vec<String> },
}

pub struct Event {
    /// Hash of the log entry's id. Resumed or forked sessions copy old entries into a
    /// new file, so this is used to count each entry only once.
    pub id: Option<u64>,
    pub t: DateTime<Utc>,
    pub kind: EventKind,
    /// The model that answered (or was asked), if the tool's log says.
    pub model: Option<String>,
    /// Tokens spent on this turn, if the tool's log says.
    pub tokens: Option<u64>,
}

impl Event {
    pub fn is_human(&self) -> bool {
        !matches!(self.kind, EventKind::Agent { .. })
    }
}

pub struct Session {
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub events: Vec<Event>,
}
