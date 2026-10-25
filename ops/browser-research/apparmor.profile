# Keep Chromium's sandbox enabled on the Ubuntu VM. This grants user namespace
# creation only to the dedicated downloaded Chromium executable, like the
# distribution's /etc/apparmor.d/chrome profile. Update after Chromium upgrades.
abi <abi/4.0>,
include <tunables/global>

profile rapi-browser /home/justn/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome flags=(unconfined) {
  userns,
}
