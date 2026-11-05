/** GramJS only reads `inspect.custom`, to make its objects print nicely in a Node console. */
export const inspect = { custom: Symbol.for('nodejs.util.inspect.custom') };
export default { inspect };
