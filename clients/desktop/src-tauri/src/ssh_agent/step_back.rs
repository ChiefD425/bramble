//! Putting the vault window back where it was once the terminal's requests are answered.
//!
//! A request brings the window forward; when nothing is asking any more, it goes back: hidden
//! again if it was hidden, behind the terminal if it was in the background, and left alone if
//! the user was already in it. The tracking is here, free of windows, so it can be tested.

use std::collections::HashSet;

/// What the window was doing before a request raised it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Before {
    InUse,
    Background,
    Minimized,
    Hidden,
}

#[derive(Default)]
pub struct Raised {
    outstanding: HashSet<String>,
    before: Option<Before>,
    epoch: u64,
}

impl Raised {
    /// An ask came up. Only the first one since the window last went back says where that was:
    /// by a later one the window is up because of us.
    pub fn ask(&mut self, id: &str, before: Before) {
        if self.before.is_none() {
            self.before = Some(before);
        }
        self.outstanding.insert(id.to_string());
        self.epoch += 1;
    }

    /// An ask ended. When nothing is asking any more, the epoch to settle with after a short
    /// wait: a request that needs something else ends one ask just before raising the next.
    pub fn done(&mut self, id: &str) -> Option<u64> {
        self.outstanding.remove(id);
        self.epoch += 1;
        self.outstanding.is_empty().then_some(self.epoch)
    }

    /// Where to put the window, if nothing asked since `epoch`. `None` to leave it.
    pub fn settle(&mut self, epoch: u64) -> Option<Before> {
        if epoch != self.epoch || !self.outstanding.is_empty() {
            return None;
        }
        self.before.take().filter(|b| *b != Before::InUse)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_window_goes_back_once_nothing_is_asking() {
        let mut r = Raised::default();
        r.ask("a", Before::Hidden);
        let epoch = r.done("a").unwrap();
        assert_eq!(r.settle(epoch), Some(Before::Hidden));
    }

    #[test]
    fn a_window_in_use_is_left_alone() {
        let mut r = Raised::default();
        r.ask("a", Before::InUse);
        let epoch = r.done("a").unwrap();
        assert_eq!(r.settle(epoch), None);
    }

    #[test]
    fn nothing_goes_back_while_another_ask_is_up() {
        let mut r = Raised::default();
        r.ask("a", Before::Background);
        r.ask("b", Before::InUse);
        assert_eq!(r.done("a"), None);
        let epoch = r.done("b").unwrap();
        assert_eq!(r.settle(epoch), Some(Before::Background));
    }

    #[test]
    fn an_ask_that_follows_keeps_where_the_window_was() {
        let mut r = Raised::default();
        r.ask("unlock", Before::Hidden);
        let first = r.done("unlock").unwrap();
        // The unlock became a switch: by now the window is up, so it reads as in use.
        r.ask("switch", Before::InUse);
        assert_eq!(r.settle(first), None, "the window stays up for the switch");
        let second = r.done("switch").unwrap();
        assert_eq!(r.settle(second), Some(Before::Hidden));
    }

    #[test]
    fn it_goes_back_once() {
        let mut r = Raised::default();
        r.ask("a", Before::Minimized);
        let epoch = r.done("a").unwrap();
        assert_eq!(r.settle(epoch), Some(Before::Minimized));
        assert_eq!(r.settle(epoch), None);
    }

    #[test]
    fn a_later_ask_restarts_the_wait() {
        let mut r = Raised::default();
        r.ask("a", Before::Background);
        let first = r.done("a").unwrap();
        r.ask("b", Before::InUse);
        let second = r.done("b").unwrap();
        assert_eq!(r.settle(first), None, "b ended too recently");
        assert_eq!(r.settle(second), Some(Before::Background));
    }

    #[test]
    fn the_next_raise_reads_the_window_again() {
        let mut r = Raised::default();
        r.ask("a", Before::Hidden);
        let epoch = r.done("a").unwrap();
        r.settle(epoch);
        r.ask("b", Before::InUse);
        let epoch = r.done("b").unwrap();
        assert_eq!(r.settle(epoch), None);
    }
}
