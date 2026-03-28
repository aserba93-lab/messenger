export class NotImplementedError extends Error {
    constructor(feature) {
        super(`TODO_NOT_IMPLEMENTED: ${feature}`);
        this.name = "NotImplementedError";
    }
}
