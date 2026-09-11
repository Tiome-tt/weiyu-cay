#![cfg(unix)]

use simple_notes_lib::platform::SafeDirectory;

#[test]
fn non_regular_import_sources_are_rejected_without_waiting_for_a_writer() {
    let source = tempfile::tempdir().unwrap();
    let fifo = source.path().join("pipe");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let directory = SafeDirectory::open(source.path(), &[], false).unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        sender
            .send(directory.open_regular("pipe", 1024).is_err())
            .unwrap();
    });
    assert!(receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("opening a FIFO must not wait for a writer"));
}
