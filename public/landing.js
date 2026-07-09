(async () => {
  const { state, $, openAuth, initCommon } = window.AppCommon;

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
})();
