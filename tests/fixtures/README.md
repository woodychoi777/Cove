# Test audio

`aac-tone.m4a` is a generated 3-second 440Hz mono sine at 44.1kHz, PCM amplitude 4000/32768, encoded as 64kbps AAC-LC in M4A using macOS `/usr/bin/afconvert -f m4af -d aac -b 64000`. It contains no music or user recordings. Long-audio browser tests override only the test track's duration metadata to exercise streaming with this small, real AAC file. Browser playback uses the original compressed bytes. No runtime encoder dependency is required by tests.

`aac-controls-tone.m4a` is the same generated 440Hz/44.1kHz mono tone at 20 seconds, encoded using the same afconvert command. It supports actual playback beyond five seconds for transport regression checks; streaming selection overrides test metadata only. No user audio is included.
