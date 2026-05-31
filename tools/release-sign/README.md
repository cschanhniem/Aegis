# AEGIS release artifact signing + SLSA provenance + SBOM

Every AEGIS npm tarball, Python wheel, and Docker image manifest published
from this repository is signed with our Ed25519 release-signing key. The
public half of the key is committed at:

```
.well-known/aegis-release-pubkey.pem
```

…so a customer / mirror operator can pin trust on a specific public key
out-of-band (e.g. by reading it from this repo over HTTPS the first time
they install) and verify every subsequent release against that pin.

Every release also publishes a CycloneDX SBOM and a SLSA v1.0 in-toto
provenance attestation. Customers can verify the full provenance chain
with `verify.mjs --attestation`, getting builder identity, source
commit, and SBOM digest in one verification.

## Quick verify

```bash
# Sig + attestation + SBOM verification in one command:
node tools/release-sign/verify.mjs \
  --in          ./agentguard-1.2.0.tgz \
  --sig         ./agentguard-1.2.0.tgz.sig.json \
  --attestation ./agentguard-1.2.0.tgz.attestation.sig.json \
  --pubkey      ./.well-known/aegis-release-pubkey.pem

# Output on success:
# OK
#   artifact:        agentguard-1.2.0.tgz
#   sha256:          df54442…
#   pubkey matches:  yes
#   attestation:     OK
#     builder:       https://github.com/Justin0504/Aegis/.github/workflows/release.yml
#     source:        git+https://github.com/Justin0504/Aegis@<commit-sha>
#     build_id:      <CI run id>
```

Exit code `0` means:

1. The artifact's SHA-256 matches what was signed.
2. The signature verifies against the public key embedded in the manifest.
3. (When `--pubkey` is supplied) the embedded public key is byte-identical
   to the AEGIS-published one — defeats a manifest forged with an attacker
   key.

## Sign (project maintainers only)

```bash
node tools/release-sign/sign.mjs \
  --in     ./dist/agentguard-1.2.0.tgz \
  --key    $AEGIS_RELEASE_SIGNING_KEY \
  --out    ./dist/agentguard-1.2.0.tgz.sig.json
```

The private key never enters the repository. CI reads it from the
`AEGIS_RELEASE_SIGNING_KEY` GitHub Actions secret; local maintainer
machines read it from `~/.config/aegis/release-signing.pem`.

## Manifest shape

```json
{
  "spec_version": "1.0.0",
  "signed_input": "{\"algorithm\":\"ed25519\",\"artifact\":\"agentguard-1.2.0.tgz\",\"sha256\":\"…\",\"purpose\":\"aegis-release\",\"signed_at\":\"2026-05-30T…\"}",
  "signature": "<base64 ed25519 signature over signed_input>",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"
}
```

`signed_input` is signed verbatim; the JSON encoding is the customary
sorted-keys-canonical form the verifier reconstructs by hashing the
artifact bytes and comparing `sha256`.

## Threat model

The signature defends against:

- **Mirror tampering** — a malicious mirror that serves the published
  filename with adversary-replaced bytes.
- **Tarball forgery in transit** — a compromise of the download path
  (CDN, proxy) that substitutes a different artifact for the same URL.
- **CI compromise** — only the holder of the signing private key can
  produce a valid manifest, so a CI-side artifact swap is detectable
  if the upstream key is rotated promptly.

It does NOT defend against:

- A repo-side compromise that REPLACES the published public key. Customers
  who pin once (by retrieving the pubkey OOB and saving it locally)
  detect this; customers who blindly trust whatever the repo serves
  today do not. The AEGIS-published public key fingerprint is logged in
  every release announcement; cross-checking the fingerprint at install
  time closes this gap.
- A signed-input replay attack where the same artifact is re-published
  under a different filename. The `artifact` field in `signed_input`
  binds the manifest to the filename, but customers should still
  cross-check filenames against the AEGIS release listing.

## Bootstrap (one-time, for new release maintainers)

```bash
# Generate a new Ed25519 keypair (do this on an air-gapped machine).
openssl genpkey -algorithm ed25519 -out aegis-release-priv.pem
openssl pkey -in aegis-release-priv.pem -pubout -out aegis-release-pubkey.pem

# Commit the PUBLIC key only.
cp aegis-release-pubkey.pem .well-known/aegis-release-pubkey.pem
git add .well-known/aegis-release-pubkey.pem
git commit -m "release: rotate signing public key"

# Store the private key in GitHub Actions secrets as AEGIS_RELEASE_SIGNING_KEY
# (paste the entire PEM including BEGIN/END lines).

# Destroy the local private key copy.
shred -u aegis-release-priv.pem
```
