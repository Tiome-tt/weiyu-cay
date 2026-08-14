use serde::Deserialize;
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Deserialize)]
struct Workflow {
    permissions: Permissions,
    jobs: BTreeMap<String, Job>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct Permissions {
    contents: String,
}

#[derive(Debug, Deserialize, Default)]
struct Job {
    #[serde(default)]
    needs: Needs,
    permissions: Option<Permissions>,
    outputs: Option<BTreeMap<String, serde_yml::Value>>,
    strategy: Option<Strategy>,
    #[serde(default)]
    steps: Vec<Step>,
}

#[derive(Debug, Deserialize, Default, PartialEq, Eq)]
#[serde(untagged)]
enum Needs {
    One(String),
    Many(Vec<String>),
    #[default]
    None,
}

impl Needs {
    fn values(&self) -> Vec<&str> {
        match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values.iter().map(String::as_str).collect(),
            Self::None => Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct Strategy {
    #[serde(rename = "max-parallel")]
    max_parallel: Option<u8>,
    matrix: Matrix,
}

#[derive(Debug, Deserialize)]
struct Matrix {
    include: Option<Vec<BTreeMap<String, String>>>,
    os: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct Step {
    name: Option<String>,
    uses: Option<String>,
    run: Option<String>,
    with: Option<BTreeMap<String, serde_yml::Value>>,
    env: Option<BTreeMap<String, serde_yml::Value>>,
}

#[test]
fn shell_command_predicates_do_not_accept_misleading_echo_text() {
    assert!(has_shell_command(
        "set -euo pipefail\npnpm tauri build",
        &["pnpm", "tauri", "build"]
    ));
    assert!(!has_shell_command(
        "echo 'pnpm tauri build'",
        &["pnpm", "tauri", "build"]
    ));
}

#[test]
fn ci_and_signed_release_gates_execute_playwright_e2e() {
    for (path, job_name) in [
        ("../.github/workflows/ci.yml", "verify"),
        ("../.github/workflows/release.yml", "verify-gates"),
    ] {
        let workflow: Workflow = parse(path);
        let gate = job(&workflow, job_name);
        assert_step_command(
            gate,
            "Install Playwright browser",
            &["pnpm", "exec", "playwright", "install", "chromium"],
        );
        assert_step_command(gate, "Test browser flows", &["pnpm", "test:e2e"]);
    }
}

#[test]
fn release_workflow_is_structurally_valid_and_serializes_signed_metadata_writers() {
    assert!(
        !Path::new("../scripts/workflow-config.test.ts").exists(),
        "workflow tests must use this YAML parser rather than indentation regexes"
    );
    let workflow: Workflow = parse("../.github/workflows/release.yml");
    assert_eq!(
        workflow.permissions,
        Permissions {
            contents: "read".to_owned()
        }
    );

    let build = job(&workflow, "build");
    assert_eq!(build.needs.values(), ["verify-tag", "verify-gates"]);
    assert_eq!(
        build.permissions,
        Some(Permissions {
            contents: "write".to_owned()
        })
    );
    let strategy = build.strategy.as_ref().expect("build strategy");
    assert_eq!(strategy.max_parallel, Some(1));
    assert_eq!(
        strategy
            .matrix
            .include
            .as_ref()
            .expect("release matrix")
            .len(),
        3
    );
    assert_step_uses(
        build,
        "tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f",
    );
    assert_step_with(
        build,
        "Build and attach signed installers and updater metadata",
        "retryAttempts",
        "3",
    );
    assert_step_with(
        build,
        "Build and attach signed installers and updater metadata",
        "releaseName",
        "Cay ${{ github.ref_name }}",
    );
    assert_step_env(
        build,
        "Materialize release-only updater configuration",
        "RELEASE_STAGING_ENDPOINT",
    );

    let verify = job(&workflow, "verify-gates");
    assert_eq!(verify.needs.values(), Vec::<&str>::new());
    assert_eq!(
        verify
            .strategy
            .as_ref()
            .and_then(|strategy| strategy.matrix.os.as_ref())
            .expect("CI OS matrix"),
        &vec!["windows-latest".to_owned(), "macos-latest".to_owned()]
    );
    assert_step_command(
        verify,
        "Build unsigned desktop bundle",
        &["pnpm", "tauri", "build"],
    );

    let checksums = job(&workflow, "checksums");
    assert_eq!(checksums.needs.values(), ["build"]);
    assert_step_uses(
        checksums,
        "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    assert_step_command(
        checksums,
        "Download draft release assets",
        &[
            "gh",
            "release",
            "view",
            "$TAG_NAME",
            "--repo",
            "$GITHUB_REPOSITORY",
            "--json",
            "assets",
            ">",
            "$RUNNER_TEMP/release-assets.json",
        ],
    );
    assert_step_command(
        checksums,
        "Download draft release assets",
        &[
            "gh",
            "release",
            "download",
            "$TAG_NAME",
            "--repo",
            "$GITHUB_REPOSITORY",
            "--dir",
            "release-assets",
        ],
    );
    assert_step_command(
        checksums,
        "Validate complete updater metadata and matching signatures",
        &[
            "node",
            "--experimental-strip-types",
            "scripts/validate-release-metadata.ts",
            "--directory",
            "release-assets",
            "--release-assets",
            "$RUNNER_TEMP/release-assets.json",
            "--repository",
            "$REPOSITORY",
            "--tag",
            "$TAG_NAME",
            "--identity-output",
            "release-assets/release-asset-identities.json",
        ],
    );
    assert_step_uses(
        checksums,
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    assert_job_output(
        checksums,
        "verified-bundle-name",
        "${{ steps.bundle-name.outputs.name }}",
    );
    assert_step_command(
        checksums,
        "Name immutable verified release bundle",
        &[
            "echo",
            "name=verified-release-bundle-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
            ">>",
            "$GITHUB_OUTPUT",
        ],
    );
    assert_step_with(
        checksums,
        "Upload immutable verified release bundle",
        "name",
        "${{ steps.bundle-name.outputs.name }}",
    );
    assert_step_with(
        checksums,
        "Upload immutable verified release bundle",
        "path",
        "release-assets",
    );
    assert_step_with(
        checksums,
        "Upload immutable verified release bundle",
        "if-no-files-found",
        "error",
    );
    assert_step_with(
        checksums,
        "Upload immutable verified release bundle",
        "retention-days",
        "1",
    );
    assert!(!workflow.jobs.contains_key("publish-prerelease"));

    let stable = job(&workflow, "prepare-stable-promotion");
    assert_eq!(stable.needs.values(), ["verify-tag", "checksums"]);
    assert_eq!(
        stable.permissions,
        Some(Permissions {
            contents: "read".to_owned()
        })
    );
    assert_step_uses(
        stable,
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    assert_step_command(
        stable,
        "Verify public stable baseline and write promotion plan",
        &[
            "node",
            "--experimental-strip-types",
            "scripts/prepare-stable-promotion.ts",
            "--candidate",
            "release-assets/latest.json",
            "--previous",
            "$RUNNER_TEMP/previous-stable-latest.json",
            "--release",
            "$RUNNER_TEMP/candidate-stable-release.json",
            "--repository",
            "$REPOSITORY",
            "--tag",
            "$TAG_NAME",
            "--output",
            "stable-promotion-plan.json",
        ],
    );
    assert_job_lacks_command(stable, &["gh", "release", "edit"]);

    let stage = job(&workflow, "stage-rc");
    assert_eq!(stage.needs.values(), ["verify-tag", "checksums"]);
    assert_eq!(
        stage.permissions,
        Some(Permissions {
            contents: "read".to_owned()
        })
    );
    assert_step_env(
        stage,
        "Mirror signed RC candidate to the stable staging channel",
        "RELEASE_STAGING_UPLOAD_TOKEN",
    );
    assert_step_uses(
        stage,
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    assert_step_with(
        stage,
        "Download immutable verified release bundle",
        "name",
        "${{ needs.checksums.outputs.verified-bundle-name }}",
    );
    assert_step_with(
        stage,
        "Download immutable verified release bundle",
        "path",
        "release-assets",
    );
    assert_job_lacks_command(
        stage,
        &[
            "gh",
            "release",
            "download",
            "$TAG_NAME",
            "--repo",
            "$GITHUB_REPOSITORY",
            "--dir",
            "release-assets",
        ],
    );
    assert_job_lacks_command(
        stage,
        &[
            "gh",
            "release",
            "view",
            "$TAG_NAME",
            "--repo",
            "$GITHUB_REPOSITORY",
            "--json",
            "assets",
            ">",
            "$RUNNER_TEMP/release-assets.json",
        ],
    );
    assert_step_command(
        stage,
        "Revalidate immutable verified release bundle",
        &["sha256sum", "--check", "SHA256SUMS"],
    );
    assert_step_command(
        stage,
        "Revalidate immutable verified release bundle",
        &[
            "node",
            "--experimental-strip-types",
            "../scripts/validate-release-metadata.ts",
            "--directory",
            ".",
            "--release-assets",
            "release-asset-identities.json",
            "--repository",
            "$REPOSITORY",
            "--tag",
            "$TAG_NAME",
        ],
    );
    assert_step_command(
        stage,
        "Mirror signed RC candidate to the stable staging channel",
        &[
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "$RELEASE_STAGING_ENDPOINT/latest.json",
            "-o",
            "$RUNNER_TEMP/previous-rc-latest.json",
        ],
    );
    assert_step_command(
        stage,
        "Mirror signed RC candidate to the stable staging channel",
        &[
            "node",
            "--experimental-strip-types",
            "scripts/stage-rc-release.ts",
            "--metadata",
            "release-assets/latest.json",
            "--release-assets",
            "release-assets/release-asset-identities.json",
            "--previous",
            "$RUNNER_TEMP/previous-rc-latest.json",
            "--endpoint",
            "$RELEASE_STAGING_ENDPOINT",
            "--output",
            "$RUNNER_TEMP/staged-rc-latest.json",
        ],
    );
    assert_step_last_command(
        stage,
        "Mirror signed RC candidate to the stable staging channel",
        &[
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--request",
            "PUT",
            "--header",
            "Authorization:",
            "Bearer",
            "$RELEASE_STAGING_UPLOAD_TOKEN",
            "--upload-file",
            "$RUNNER_TEMP/staged-rc-latest.json",
            "$RELEASE_STAGING_ENDPOINT/latest.json",
        ],
    );

    for job in workflow.jobs.values() {
        for step in &job.steps {
            if let Some(action) = &step.uses {
                assert!(is_commit_pinned(action), "action is not pinned: {action}");
            }
        }
    }
}

fn parse(path: &str) -> Workflow {
    serde_yml::from_str(&fs::read_to_string(path).expect("workflow source"))
        .expect("valid workflow YAML")
}

fn job<'a>(workflow: &'a Workflow, name: &str) -> &'a Job {
    workflow
        .jobs
        .get(name)
        .unwrap_or_else(|| panic!("missing job: {name}"))
}

fn assert_step_uses(job: &Job, action: &str) {
    assert!(
        job.steps
            .iter()
            .any(|step| step.uses.as_deref() == Some(action)),
        "missing action: {action}"
    );
}

fn assert_step_command(job: &Job, name: &str, expected: &[&str]) {
    let run = job
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .and_then(|step| step.run.as_deref())
        .unwrap_or_else(|| panic!("missing run step: {name}"));
    assert!(
        has_shell_command(run, expected),
        "{name} is missing command: {}",
        expected.join(" ")
    );
}

fn assert_job_lacks_command(job: &Job, unexpected: &[&str]) {
    assert!(
        job.steps
            .iter()
            .filter_map(|step| step.run.as_deref())
            .all(|run| !has_shell_command(run, unexpected)),
        "job unexpectedly contains command: {}",
        unexpected.join(" ")
    );
}

fn has_shell_command(script: &str, expected: &[&str]) -> bool {
    script.lines().any(|line| shell_tokens(line) == expected)
}

fn assert_step_last_command(job: &Job, name: &str, expected: &[&str]) {
    let tokens = job
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .and_then(|step| step.run.as_deref())
        .and_then(|run| run.lines().rev().find(|line| !line.trim().is_empty()))
        .map(shell_tokens)
        .unwrap_or_else(|| panic!("missing run step: {name}"));
    assert_eq!(tokens, expected, "{name} must publish the manifest last");
}

fn shell_tokens(line: &str) -> Vec<&str> {
    line.split_whitespace()
        .map(|token| token.trim_matches(['\'', '"']))
        .collect()
}

fn assert_step_with(job: &Job, name: &str, key: &str, expected: &str) {
    let value = job
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .and_then(|step| step.with.as_ref())
        .and_then(|values| values.get(key))
        .map(|value| {
            serde_yml::to_string(value)
                .expect("YAML value")
                .trim()
                .to_owned()
        });
    assert_eq!(value.as_deref(), Some(expected), "{name} {key}");
}

fn assert_job_output(job: &Job, key: &str, expected: &str) {
    let value = job
        .outputs
        .as_ref()
        .and_then(|outputs| outputs.get(key))
        .map(|value| {
            serde_yml::to_string(value)
                .expect("YAML value")
                .trim()
                .to_owned()
        });
    assert_eq!(value.as_deref(), Some(expected), "job output {key}");
}

fn assert_step_env(job: &Job, name: &str, key: &str) {
    let environment = job
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .and_then(|step| step.env.as_ref())
        .unwrap_or_else(|| panic!("missing environment for {name}"));
    assert!(environment.contains_key(key), "{name} is missing {key}");
}

fn is_commit_pinned(action: &str) -> bool {
    let Some((_, reference)) = action.split_once('@') else {
        return false;
    };
    reference.len() == 40 && reference.bytes().all(|byte| byte.is_ascii_hexdigit())
}
