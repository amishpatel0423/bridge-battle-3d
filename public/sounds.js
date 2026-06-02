/* Web Audio sound engine — same pattern as the 2D game */
let _ac;
function _audio() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  return _ac;
}
function _beep(freq, type = 'sine', dur = 0.12, vol = 0.18) {
  try {
    const ac = _audio(), o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = type;
    o.frequency.setValueAtTime(freq, ac.currentTime);
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.start(); o.stop(ac.currentTime + dur);
  } catch (_) {}
}
function sfxPlace()   { _beep(200, 'triangle', 0.1); }
function sfxPickup()  { _beep(440, 'sine', 0.07); setTimeout(() => _beep(660, 'sine', 0.1), 60); }
function sfxUpgrade() { [523,659,784,1047].forEach((f, i) => setTimeout(() => _beep(f, 'triangle', 0.2, 0.15), i*80)); }
function sfxAttack()  { _beep(500, 'sawtooth', 0.06, 0.12); setTimeout(() => _beep(300, 'sawtooth', 0.1), 60); }
function sfxFall()    { [400,280,180,110].forEach((f, i) => setTimeout(() => _beep(f, 'sine', 0.1), i*55)); }
function sfxWin()     { [523,659,784,1047,1319].forEach((f, i) => setTimeout(() => _beep(f, 'triangle', 0.25, 0.2), i*90)); }
function sfxFlag()    { [880,1108,1319].forEach((f, i) => setTimeout(() => _beep(f, 'sine', 0.3, 0.15), i*100)); }
function sfxJoin()    { _beep(660, 'sine', 0.1); setTimeout(() => _beep(880, 'sine', 0.15), 80); }
