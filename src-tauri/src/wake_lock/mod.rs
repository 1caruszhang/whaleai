//! Process-scoped wake lock used while a Xiaojing Session has an active turn.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux::PlatformImpl;
#[cfg(target_os = "macos")]
use macos::PlatformImpl;
#[cfg(target_os = "windows")]
use windows::PlatformImpl;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod noop {
    pub struct PlatformImpl;

    impl PlatformImpl {
        pub fn acquire(_reason: &str) -> Result<Self, String> {
            Ok(Self)
        }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use noop::PlatformImpl;

pub struct WakeLock {
    #[allow(dead_code)]
    _inner: PlatformImpl,
}

impl WakeLock {
    pub fn acquire(reason: &str) -> Result<Self, String> {
        PlatformImpl::acquire(reason).map(|inner| Self { _inner: inner })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_and_release_smoke() {
        drop(WakeLock::acquire("Xiaojing active turn").expect("wake lock"));
    }
}
