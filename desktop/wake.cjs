const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { wakeTime } = require('./alarm.cjs');
const run = promisify(execFile);
// pmset -g sched separates repeating events from one-time events. Unknown
// repeat syntax is a conflict, never permission to overwrite it.
function repeatLines(text) {
  const match = text.match(/Repeating power events:\s*\n([\s\S]*?)(?=Scheduled power events:|$)/i);
  return match ? match[1].split('\n').map(s => s.trim()).filter(Boolean) : [];
}
function ownsRepeat(text, ownedTime) {
  const lines = repeatLines(text);
  if (!ownedTime || lines.length !== 1) return false;
  const match = lines[0].match(/^wake at (\d{1,2}):(\d{2})(?::(\d{2}))?(AM|PM)? every day$/i);
  if (!match) return false;
  let h = +match[1]; if (match[4]) h = h % 12 + (match[4].toUpperCase() === 'PM' ? 12 : 0);
  return `${String(h).padStart(2,'0')}:${match[2]}:${match[3] || '00'}` === ownedTime;
}
class WakeSchedule {
  constructor({ helper, state, persist, command = run }) { Object.assign(this, { helper, state, persist, command }); }
  async inspect() {
    const { stdout } = await this.command('/usr/bin/pmset', ['-g', 'sched'], { timeout: 5000, maxBuffer: 65536 });
    return stdout;
  }
  async status(config) {
    if (process.platform !== 'darwin') return { ready: false, message: '앱 실행 중에 알람이 울립니다. Windows 잠자기 깨우기는 지원하지 않습니다.' };
    try {
      const text = await this.inspect();
      const owned = ownsRepeat(text, this.state.ownedTime);
      const ready = config.enabled && owned && this.state.ownedTime === wakeTime(config.time);
      return { ready, message: ready ? '깨우기 예약 설정됨 · 실제 잠자기 동작은 기기에서 확인해 주세요.' : repeatLines(text).length && !owned ? '다른 반복 전원 예약이 있습니다. 기존 예약은 변경하지 않습니다.' : config.enabled ? '깨우기 예약 설정이 필요합니다.' : owned ? '알람은 꺼져 있지만 깨우기 예약이 남아 있습니다. 다시 저장하여 예약을 해제해 주세요.' : '알람이 꺼져 있습니다.' };
    } catch { return { ready: false, message: 'macOS 깨우기 예약을 확인하지 못했습니다.' }; }
  }
  async configure(config) {
    if (process.platform !== 'darwin') return;
    const text = await this.inspect(), lines = repeatLines(text), owned = ownsRepeat(text, this.state.ownedTime);
    if (lines.length && !owned) {
      if (config.enabled) throw Error('다른 반복 전원 예약이 있습니다. 기존 예약을 정리한 뒤 다시 저장해 주세요.');
      this.state.ownedTime = null; this.persist(); return;
    }
    const target = config.enabled ? wakeTime(config.time) : null;
    if ((target && owned && target === this.state.ownedTime) || (!target && !owned)) return;
    // Persist recovery intent before authorization in case the app closes mid-dialog.
    this.state.pendingTime = target; this.persist();
    try {
      await this.command(this.helper, [target || 'cancel', owned ? this.state.ownedTime : 'none'], { timeout: 120000, maxBuffer: 65536 });
      const after = await this.inspect();
      if (target ? !ownsRepeat(after, target) : repeatLines(after).length > 0) throw Error('깨우기 예약 적용을 확인하지 못했습니다.');
      this.state.ownedTime = target; this.state.pendingTime = null; this.persist();
    } catch (error) { throw Error(/canceled|cancelled|60006/i.test(String(error.stderr || error.message)) ? '관리자 인증을 취소했습니다. 깨우기 예약은 완료되지 않았습니다.' : `깨우기 예약을 설정하지 못했습니다. ${String(error.stderr || error.message).trim().slice(0,240)}`); }
  }
}
module.exports = { repeatLines, ownsRepeat, WakeSchedule };
