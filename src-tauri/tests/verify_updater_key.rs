use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::Path};

#[test]
#[ignore = "the release workflow supplies its owner-only updater key pair"]
fn release_owner_key_pair_verifies_a_signed_probe() {
    let payload_path = env::var_os("UPDATER_PROBE_PATH").expect("release probe payload path");
    let signature_path =
        env::var_os("UPDATER_PROBE_SIGNATURE_PATH").expect("release probe signature path");
    let encoded_public_key =
        env::var("TAURI_UPDATER_PUBLIC_KEY").expect("release updater public key");
    let public_key_text = STANDARD
        .decode(encoded_public_key.trim())
        .expect("base64 updater public key");
    let public_key_text = std::str::from_utf8(&public_key_text).expect("UTF-8 updater public key");
    let signature_base64 = fs::read_to_string(&signature_path).expect("release probe signature");
    let signature_text = STANDARD
        .decode(signature_base64.trim())
        .expect("base64 updater signature");
    let signature_text = std::str::from_utf8(&signature_text).expect("UTF-8 updater signature");
    let payload = fs::read(Path::new(&payload_path)).expect("release probe payload");

    let public_key = PublicKey::decode(public_key_text).expect("valid updater public key");
    let signature = Signature::decode(signature_text).expect("valid updater signature");
    public_key
        .verify(&payload, &signature, true)
        .expect("updater public key must verify the private-key probe");
}
