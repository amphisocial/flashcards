(async () => {
  const { state, $, openAuth, initCommon, setStatus } = window.AppCommon;

  $('#ctaStart').addEventListener('click', () => {
    if (state.user) {
      window.location.href = '/app';
    } else {
      openAuth('signup');
    }
  });

  await initCommon();

  const params = new URLSearchParams(window.location.search);
  if (params.has('login') && !state.user) {
    openAuth(params.get('login') === '0' ? 'signup' : 'login');
  }
  if (params.has('googleError')) {
    setStatus(`Google sign-in failed: ${params.get('googleError')}`, 'error');
    params.delete('googleError');
    const rest = params.toString();
    window.history.replaceState({}, '', rest ? `${window.location.pathname}?${rest}` : window.location.pathname);
  }
})();
