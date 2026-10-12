use zeroize::Zeroize;

use super::JumpHostConfig;
use crate::crypto::CryptoManager;
use crate::db::{profile::Profile, Database};

/// Resolved secrets live only for connection/authentication, never in job records.
pub(crate) struct ProfileTarget {
    pub(crate) profile: Profile,
    pub(crate) jump: Option<JumpHostConfig>,
}

impl ProfileTarget {
    pub(crate) fn resolve(
        db: &Database,
        crypto: &CryptoManager,
        profile_id: i64,
    ) -> Result<Self, String> {
        let mut target = Self {
            profile: db.get_profile(profile_id, crypto)?,
            jump: None,
        };
        if target.profile.protocol != "ssh" {
            return Err("Automation supports SSH profiles only".into());
        }
        target.jump = target
            .profile
            .jump_host
            .as_deref()
            .filter(|raw| !raw.is_empty())
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| "Invalid jump host configuration".to_string())?;
        Ok(target)
    }
}

impl Drop for ProfileTarget {
    fn drop(&mut self) {
        if let Some(value) = &mut self.profile.password {
            value.zeroize();
        }
        if let Some(value) = &mut self.profile.jump_host {
            value.zeroize();
        }
        if let Some(value) = self.jump.as_mut().and_then(|jump| jump.password.as_mut()) {
            value.zeroize();
        }
    }
}
