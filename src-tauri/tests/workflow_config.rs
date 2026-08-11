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
    assert_step_run(verify, "Build unsigned desktop bundle", "pnpm tauri build");

    let checksums = job(&workflow, "checksums");
    assert_eq!(checksums.needs.values(), ["build"]);
    assert_step_uses(
        checksums,
        "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    assert_step_run(
        checksums,
        "Download draft release assets",
        "gh release view",
    );
    assert_step_run(
        checksums,
        "Download draft release assets",
        "$RUNNER_TEMP/release-assets.json",
    );
    assert_step_run(
        checksums,
        "Validate complete updater metadata and matching signatures",
        "$RUNNER_TEMP/release-assets.json",
    );
    assert_step_run_not_contains(
        checksums,
        "Download draft release assets",
        "release-assets/release-assets.json",
    );
    assert_step_run(
        checksums,
        "Validate complete updater metadata and matching signatures",
        "validate-release-metadata.ts",
    );
    assert!(!workflow.jobs.contains_key("publish-prerelease"));

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

fn assert_step_run(job: &Job, name: &str, expected: &str) {
    let run = job
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .and_then(|step| step.run.as_deref())
        .unwrap_or_else(|| panic!("missing run step: {name}"));
    assert!(run.contains(expected), "{name} is missing {expected}");
}

fn assert_step_run_not_contains(job: &Job, name: &str, forbidden: &str) {
    let run = job
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .and_then(|step| step.run.as_deref())
        .unwrap_or_else(|| panic!("missing run step: {name}"));
    assert!(
        !run.contains(forbidden),
        "{name} must not contain {forbidden}"
    );
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
