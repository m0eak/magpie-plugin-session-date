(async () => {
  const status = document.getElementById('status');
  try {
    await window.magpie?.ready;
    const service = window.magpie?.service;
    if (!service) throw new Error('当前宿主未提供 page.service 代理。');
    const url = new URL(service, location.href);
    url.searchParams.set('uiOrigin', url.origin);
    const theme = window.magpie?.theme;
    if (theme) {
      url.searchParams.set('theme', theme.dark ? 'dark' : 'light');
      if (theme.lang) url.searchParams.set('lang', theme.lang);
    }
    location.replace(url.href);
  } catch (error) {
    status.textContent = '统计服务不可用 / Statistics service unavailable.';
  }
})();
