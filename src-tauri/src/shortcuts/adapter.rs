use super::{normalize_accelerator, ShortcutError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceleratorPlatform {
    Windows,
    MacOs,
    Linux,
}

impl AcceleratorPlatform {
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Self::MacOs
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Self::Linux
        }
    }
}

pub fn map_accelerator_for_platform(
    accelerator: &str,
    platform: AcceleratorPlatform,
) -> Result<String, ShortcutError> {
    let canonical = normalize_accelerator(accelerator)?;
    let command_or_control = match platform {
        AcceleratorPlatform::Windows | AcceleratorPlatform::Linux => "Control",
        AcceleratorPlatform::MacOs => "Command",
    };
    Ok(canonical
        .split('+')
        .map(|part| {
            if part == "CommandOrControl" {
                command_or_control
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("+"))
}
