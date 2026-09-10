use super::common::SessionFileCandidate;
use super::common::detect_recent_sessions;
use crate::model::ExternalAgentSessionImportLimits;
use crate::sessions::ExternalAgentSessionMigration;
use crate::sessions::SessionRecordFormat;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

const MAX_CUR_PROJECT_PATH_PROBES: usize = 128;

pub fn detect_recent_cur_sessions(
    external_agent_home: &Path,
    codex_home: &Path,
) -> io::Result<Vec<ExternalAgentSessionMigration>> {
    detect_recent_cur_sessions_with_limits(
        external_agent_home,
        codex_home,
        ExternalAgentSessionImportLimits::default(),
    )
}

pub(crate) fn detect_recent_cur_sessions_with_limits(
    external_agent_home: &Path,
    codex_home: &Path,
    limits: ExternalAgentSessionImportLimits,
) -> io::Result<Vec<ExternalAgentSessionMigration>> {
    let projects_root = external_agent_home.join("projects");
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut candidates = Vec::new();
    for project_entry in fs::read_dir(projects_root)? {
        let Ok(project_entry) = project_entry else {
            continue;
        };
        let project_storage = project_entry.path();
        if !project_storage.is_dir() {
            continue;
        }
        let fallback_cwd = cur_project_cwd(&project_storage, external_agent_home);
        for path in cur_transcript_files(&project_storage.join("agent-transcripts")) {
            candidates.push(SessionFileCandidate {
                path,
                fallback_cwd: fallback_cwd.clone(),
                record_format: SessionRecordFormat::Cur,
            });
        }
    }
    detect_recent_sessions(
        codex_home, candidates, /*require_existing_cwd*/ false, limits,
    )
}

fn cur_transcript_files(transcripts_root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![transcripts_root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if entry.file_name() != "subagents" {
                    pending.push(path);
                }
            } else if file_type.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn cur_project_cwd(project_storage: &Path, external_agent_home: &Path) -> Option<PathBuf> {
    let encoded = project_storage.file_name()?.to_str()?;
    // Cursor stores projectless chats under this reserved project name.
    if encoded == "empty-window" {
        let external_agent_home = if external_agent_home.is_absolute() {
            external_agent_home.to_path_buf()
        } else {
            std::env::current_dir().ok()?.join(external_agent_home)
        };
        return external_agent_home.parent().map(Path::to_path_buf);
    }
    decode_cur_project_path(encoded)
}

fn decode_cur_project_path(encoded: &str) -> Option<PathBuf> {
    #[cfg(not(windows))]
    let path = PathBuf::from("/");

    #[cfg(windows)]
    let (encoded, path) = {
        let (drive, encoded) = decode_cur_windows_project_drive(encoded)?;
        (encoded, PathBuf::from(format!("{drive}:\\")))
    };

    let encoded = encoded.strip_prefix('-').unwrap_or(encoded);
    if encoded.contains(['/', '\\', ':'])
        || encoded
            .split('-')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return None;
    }

    // A hyphen can encode a directory boundary or punctuation inside any ancestor.
    // Match real directory names at every boundary, and reject ambiguous or incomplete searches.
    let mut pending = vec![(path, encoded)];
    let mut matched_path = None;
    let mut probes = 0;
    while let Some((parent, remaining)) = pending.pop() {
        if probes >= MAX_CUR_PROJECT_PATH_PROBES {
            return None;
        }
        probes += 1;
        for entry in fs::read_dir(parent).ok()? {
            let entry = entry.ok()?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let normalized_name = name
                .split(['-', '_', '.', ' ', '+', '@', '&'])
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            for (index, encoded_name) in [name, normalized_name.as_str()].into_iter().enumerate() {
                if encoded_name.is_empty() || (index == 1 && encoded_name == name) {
                    continue;
                }
                let Some(prefix) = remaining.get(..encoded_name.len()) else {
                    continue;
                };
                let matches_name = if cfg!(windows) {
                    prefix.eq_ignore_ascii_case(encoded_name)
                } else {
                    prefix == encoded_name
                };
                if !matches_name {
                    continue;
                }
                let suffix = &remaining[encoded_name.len()..];
                let suffix = if suffix.is_empty() {
                    suffix
                } else if let Some(suffix) = suffix.strip_prefix('-') {
                    suffix
                } else {
                    continue;
                };
                let candidate = entry.path();
                if !candidate.is_dir() {
                    continue;
                }
                if suffix.is_empty() {
                    if matched_path.is_some() {
                        return None;
                    }
                    matched_path = Some(candidate);
                } else {
                    if probes + pending.len() >= MAX_CUR_PROJECT_PATH_PROBES {
                        return None;
                    }
                    pending.push((candidate, suffix));
                }
            }
        }
    }

    matched_path
}

#[cfg(any(windows, test))]
fn decode_cur_windows_project_drive(encoded: &str) -> Option<(char, &str)> {
    let drive = encoded.as_bytes().first().copied()?;
    if !drive.is_ascii_alphabetic() || encoded.as_bytes().get(1) != Some(&b'-') {
        return None;
    }

    Some((char::from(drive), encoded.get(2..)?))
}

#[cfg(test)]
#[path = "cur_tests.rs"]
mod tests;
