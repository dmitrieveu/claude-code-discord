// Process management and crash handling exports
export { 
  ProcessCrashHandler, 
  setupGlobalErrorHandlers, 
  ProcessHealthMonitor,
  withCrashReporting
} from "./crash-handler.ts";
export type { 
  CrashReport, 
  RecoveryOptions 
} from "./crash-handler.ts";

// IPC management exports
export {
  IPCManager,
  createParentIPC,
  createChildIPC
} from "./ipc-manager.ts";
export type {
  IPCMessage,
  IPCMessageType,
  IPCOptions
} from "./ipc-manager.ts";

// Child process handler exports
export {
  initializeChildHandler,
  ensureChildExitsWithParent
} from "./child-handler.ts";