# termenbox-ci

Build harness for the private termenbox source. Contains workflows only. Logs are withheld; failures are read by
decrypting the uploaded artifact: `openssl enc -d -aes-256-cbc -pbkdf2 -pass env:LOG_KEY -in build.log.enc`.
