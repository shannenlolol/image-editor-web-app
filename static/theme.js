(() => {
    const storageKey = 'image-editor-theme';
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    let preference = null;
    try {
        const saved = localStorage.getItem(storageKey);
        if (saved === 'light' || saved === 'dark') preference = saved;
    } catch {
        // Theme switching still works when browser storage is unavailable.
    }

    function applyTheme() {
        const theme = preference || (systemTheme?.matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = theme;
        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.setAttribute('aria-pressed', String(theme === 'dark'));
            toggle.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
        }
    }

    // Run in the head before styles load to avoid a light flash on dark pages.
    applyTheme();
    systemTheme?.addEventListener('change', () => {
        if (!preference) applyTheme();
    });
    document.addEventListener('DOMContentLoaded', () => {
        applyTheme();
        document.getElementById('themeToggle').addEventListener('click', () => {
            preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
            applyTheme();
            try {
                localStorage.setItem(storageKey, preference);
            } catch {
                // Keep the selection for this page even if it cannot be saved.
            }
        });
    });
})();
