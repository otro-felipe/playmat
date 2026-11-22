export class ToolError extends Error {
  constructor(code, message, { actionIndex, field, paymentIndex } = {}) {
    super(message);
    this.code = code;
    if (actionIndex !== undefined) this.actionIndex = actionIndex;
    if (field !== undefined) this.field = field;
    if (paymentIndex !== undefined) this.paymentIndex = paymentIndex;
  }
}
