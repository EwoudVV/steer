use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

/// Features of one prompt, computed on this computer. The prompt text itself is
/// dropped as soon as these are computed; only counts, flags and word hashes remain.
pub struct PromptInfo {
    pub chars: usize,
    pub words: usize,
    pub images: usize,
    /// Count of concrete references: file names, paths, identifiers, numbers, code.
    pub specific: u32,
    /// The prompt reports what happened when the human tried something.
    pub observation: bool,
    /// Short, generic prompts like "continue" or "fix it".
    pub generic: bool,
    /// The model that answered (or was asked), if the tool's log says.
    pub model: Option<String>,
    /// Tokens spent on this turn, if the tool's log says.
    pub tokens: Option<u64>,
    word_hashes: HashSet<u64>,
}

const GENERIC: &[&str] = &[
    "continue", "go", "go on", "go ahead", "yes", "y", "yep", "yeah", "ok", "okay", "k",
    "do it", "fix it", "fix", "fix this", "keep going", "proceed", "try again", "again",
    "next", "sure", "lgtm", "looks good", "retry", "more", "same", "please", "pls",
];

const OBSERVATION: &[&str] = &[
    "when i", "it shows", "it says", "doesn't", "doesnt", "does not", "didn't", "didnt",
    "not working", "isn't", "isnt", "broken", "broke", "i clicked", "i tried", "i see",
    "i get", "i got", "instead of", "still", "now it", "works now", "it works", "crash",
    "error", "fails", "failed", "freez", "stuck", "wrong", "nothing happens", "blank",
    "undefined", "exception", "traceback", "warning", "bug", "glitch", "flicker", "lag",
];

impl PromptInfo {
    pub fn analyze(text: &str, images: usize) -> Self {
        Self::analyze_with(text, images, None, None)
    }

    /// Like `analyze`, plus which model ran it and how many tokens the turn spent.
    pub fn analyze_with(text: &str, images: usize, model: Option<String>, tokens: Option<u64>) -> Self {
        let typed = typed_part(text);
        let typed_words = typed.split_whitespace().count();
        let lower = text.to_lowercase();
        let normalized: String = lower
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' })
            .collect();
        let norm_words: Vec<&str> = normalized.split_whitespace().collect();
        let joined = norm_words.join(" ");

        let mut specific = text.split_whitespace().filter(|w| is_specific(w)).count() as u32;
        if text.contains('`') {
            specific += 1;
        }
        if text.lines().filter(|l| !l.trim().is_empty()).count() > 3 {
            specific += 1;
        }
        let observation = images > 0 || OBSERVATION.iter().any(|p| lower.contains(p));
        let generic = images == 0
            && (GENERIC.contains(&joined.as_str())
                || (norm_words.len() <= 3 && specific == 0 && !observation));

        Self {
            chars: typed.chars().count(),
            words: typed_words,
            images,
            // A paste can name more files than the typed words, which no typed prompt can.
            specific: specific.min(typed_words as u32 + 2),
            observation,
            generic,
            model,
            tokens,
            word_hashes: norm_words.iter().filter(|w| w.len() > 2).map(|w| hash(w)).collect(),
        }
    }

    /// Rough time to type the prompt, at about 48 words per minute.
    pub fn typing_secs(&self) -> i64 {
        ((self.chars as f64) / 4.0).round().clamp(5.0, 300.0) as i64
    }

    /// Word-overlap similarity (0 to 1) with another prompt.
    pub fn similarity(&self, other: &Self) -> f64 {
        self.similarity_to(&other.word_hashes)
    }

    /// Same as `similarity`, against word hashes saved from an earlier prompt.
    pub fn similarity_to(&self, other: &HashSet<u64>) -> f64 {
        if self.word_hashes.is_empty() || other.is_empty() {
            return 0.0;
        }
        let shared = self.word_hashes.intersection(other).count() as f64;
        let total = self.word_hashes.union(other).count() as f64;
        shared / total
    }

    /// The prompt's word hashes, so the next prompt can be compared to it later.
    /// These stay on this computer.
    pub fn word_hashes(&self) -> &HashSet<u64> {
        &self.word_hashes
    }
}

fn hash(word: &str) -> u64 {
    let mut h = DefaultHasher::new();
    word.hash(&mut h);
    h.finish()
}

fn is_specific(raw: &str) -> bool {
    let w = raw
        .trim_matches(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '/' | '.' | ':' | '(' | ')')))
        .trim_end_matches('.');
    if w.chars().count() < 2 {
        return false;
    }
    let digit = w.chars().any(|c| c.is_ascii_digit());
    let path = w.contains('/') || has_extension(w);
    let ident = w.contains('_') || w.contains("::") || w.ends_with("()") || is_camel(w);
    digit || path || ident
}

fn has_extension(w: &str) -> bool {
    match w.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && ext.chars().any(|c| c.is_ascii_alphabetic())
        }
        None => false,
    }
}

fn is_camel(w: &str) -> bool {
    let cs: Vec<char> = w.chars().collect();
    cs.windows(2).any(|p| p[0].is_lowercase() && p[1].is_uppercase())
}

/// Claude Code's hook wraps pasted text in <pasted_content ...>...</pasted_content>.
/// Pasting takes no typing, so only the rest counts for words and typing time. Same as
/// typedPart in web/steer.js.
pub fn typed_part(text: &str) -> String {
    const CLOSE: &str = "</pasted_content>";
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<pasted_content") {
        let Some(end) = rest[start..].find(CLOSE).map(|e| start + e) else { break };
        out.push_str(&rest[..start]);
        rest = &rest[end + CLOSE.len()..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_text_is_not_typing() {
        let trace = "Traceback src/main.py line 4 src/db.py line 9 ".repeat(30);
        let p = PromptInfo::analyze(&format!("why does this crash <pasted_content id=\"1\">{trace}</pasted_content>"), 0);
        assert_eq!(p.words, 4);
        assert_eq!(p.chars, "why does this crash ".chars().count());
        assert!(p.typing_secs() <= 5 + 1);
        assert!(p.specific <= p.words as u32 + 2, "never more file names than typed words");
        // Without the marker, everything is typing like before.
        assert_eq!(PromptInfo::analyze("fix the jump", 0).words, 3);
    }

    #[test]
    fn generic_prompts() {
        assert!(PromptInfo::analyze("continue", 0).generic);
        assert!(PromptInfo::analyze("Fix it.", 0).generic);
        assert!(!PromptInfo::analyze("the jump in player.rs feels floaty, lower gravity to 20", 0).generic);
    }

    #[test]
    fn observations() {
        assert!(PromptInfo::analyze("when i click play nothing happens", 0).observation);
        assert!(PromptInfo::analyze("", 1).observation);
        assert!(!PromptInfo::analyze("add a settings page", 0).observation);
    }

    #[test]
    fn similarity() {
        let a = PromptInfo::analyze("make the button bigger and blue", 0);
        let b = PromptInfo::analyze("make the button bigger and blue please", 0);
        let c = PromptInfo::analyze("write tests for the parser", 0);
        assert!(a.similarity(&b) > 0.6);
        assert!(a.similarity(&c) < 0.2);
    }
}
