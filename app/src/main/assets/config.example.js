// config.js is generated — don't edit it by hand:
//
//   node tools/make-token.mjs --key ~/.config/nocturnify-am/AuthKey_KEYID.p8 --team TEAMID
//
// It holds the MusicKit developer token (an ES256 JWT signed with your Media Services key, valid
// for at most six months). The token identifies YOUR developer account to Apple, so each install
// mints its own rather than sharing one; config.js is gitignored.
window.CONFIG = {
  developerToken: 'PUT_A_TOKEN_FROM_make-token.mjs_HERE',
  tokenExpires: '2000-01-01',
  appName: 'Nocturnify',
};
