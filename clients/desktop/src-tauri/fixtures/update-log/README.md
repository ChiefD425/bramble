# Update-log test fixture

`fixture.txt.proof` proves `fixture.txt` is in Sigsum's test log (policy `sigsum-test1-2025`), signed
by a throwaway key whose public half is `TEST_KEY` in `src/update_log.rs` and whose private half was
deleted. It was made with the sigsum-go tools, v0.14.1:

```sh
sigsum-key generate -o test-key
sigsum-submit -P sigsum-test1-2025 -k test-key fixture.txt
sigsum-verify -k test-key.pub -P sigsum-test1-2025 fixture.txt.proof < fixture.txt
```

The proof stays valid for as long as the `sigsum` crate's built-in `sigsum-test1-2025` policy names
the same log and witnesses. If a crate upgrade changes that, make a new one the same way.
