/** GramJS asks this for the name shown under Devices in Telegram. The client passes its own, so these are only a fallback. */
const os = { type: () => 'Browser', release: () => 'Web' };
export default os;
export const type = os.type;
export const release = os.release;
