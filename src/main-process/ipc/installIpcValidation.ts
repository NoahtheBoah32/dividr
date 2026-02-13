import {
  app,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  IPC_INVOKE_ARG_SCHEMAS,
  IPC_SEND_ARG_SCHEMAS,
  createIpcMissingSchemaErrorResponse,
  createIpcValidationErrorResponse,
} from '../../shared/ipc/schemas';

const IPC_VALIDATION_INSTALLED_KEY = '__dividrIpcValidationInstalled__';

type MutableGlobal = typeof globalThis & {
  [IPC_VALIDATION_INSTALLED_KEY]?: boolean;
};

function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === 'development' || !app.isPackaged;
}

function logValidationFailure(
  channel: string,
  message: string,
  details?: unknown,
): void {
  if (!isDevelopmentMode()) return;
  if (details !== undefined) {
    console.warn(`[IPC Validation] ${message} (${channel})`, details);
  } else {
    console.warn(`[IPC Validation] ${message} (${channel})`);
  }
}

export function installIpcValidation(): void {
  const globalState = globalThis as MutableGlobal;
  if (globalState[IPC_VALIDATION_INSTALLED_KEY]) {
    return;
  }

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);

  ipcMain.handle = ((channel, listener) => {
    const schema = IPC_INVOKE_ARG_SCHEMAS[channel];
    if (!schema) {
      logValidationFailure(channel, 'Missing invoke schema');
      return originalHandle(channel, async () => {
        return createIpcMissingSchemaErrorResponse(channel);
      });
    }

    return originalHandle(
      channel,
      async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          logValidationFailure(
            channel,
            'Invoke payload validation failed',
            parsed.error.issues,
          );
          return createIpcValidationErrorResponse(channel, parsed.error);
        }

        return listener(event, ...parsed.data);
      },
    );
  }) as typeof ipcMain.handle;

  ipcMain.on = ((channel, listener) => {
    const schema = IPC_SEND_ARG_SCHEMAS[channel];
    if (!schema) {
      logValidationFailure(channel, 'Missing send schema');
      return originalOn(channel, () => {
        logValidationFailure(
          channel,
          'Dropped send payload due to missing schema',
        );
      });
    }

    return originalOn(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        logValidationFailure(
          channel,
          'Send payload validation failed',
          parsed.error.issues,
        );
        return;
      }

      listener(event, ...parsed.data);
    });
  }) as typeof ipcMain.on;

  globalState[IPC_VALIDATION_INSTALLED_KEY] = true;
}
