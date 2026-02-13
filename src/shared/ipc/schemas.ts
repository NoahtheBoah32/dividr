import { z, type ZodError, type ZodType } from 'zod';
import { IPC_CHANNELS } from './channels';

const EMPTY_ARGS_SCHEMA = z.tuple([]);
const RECORD_SCHEMA = z.record(z.string(), z.unknown());

const BINARY_BUFFER_SCHEMA = z.custom<ArrayBuffer | ArrayBufferView>(
  (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value),
  { message: 'Expected binary buffer payload' },
);

const TRACK_INPUT_SCHEMA = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      startTime: z.number().finite().optional(),
      duration: z.number().finite().optional(),
      timelineStartFrame: z.number().finite().optional(),
      timelineEndFrame: z.number().finite().optional(),
    })
    .passthrough(),
]);

const VIDEO_EDIT_JOB_SCHEMA = z
  .object({
    inputs: z.array(TRACK_INPUT_SCHEMA).min(1),
    output: z.string().min(1),
    operations: z.object({}).passthrough(),
    outputPath: z.string().optional(),
  })
  .passthrough();

const APP_EXIT_DECISION_SCHEMA = z
  .object({
    requestId: z.number().int().nonnegative().optional(),
    decision: z.enum(['pending', 'allow', 'cancel']).optional(),
  })
  .passthrough();

const TITLEBAR_OVERLAY_SCHEMA = z
  .object({
    color: z.string().optional(),
    symbolColor: z.string().optional(),
    height: z.number().finite().optional(),
  })
  .passthrough();

const OPEN_FILE_DIALOG_OPTIONS_SCHEMA = z
  .object({
    title: z.string().min(1).optional(),
    filters: z
      .array(
        z.object({
          name: z.string().min(1),
          extensions: z.array(z.string().min(1)).min(1),
        }),
      )
      .optional(),
    properties: z
      .array(z.enum(['openFile', 'openDirectory', 'multiSelections']))
      .optional(),
  })
  .passthrough();

const SAVE_DIALOG_OPTIONS_SCHEMA = z
  .object({
    title: z.string().min(1).optional(),
    defaultPath: z.string().optional(),
    buttonLabel: z.string().min(1).optional(),
    filters: z
      .array(
        z.object({
          name: z.string().min(1),
          extensions: z.array(z.string().min(1)).min(1),
        }),
      )
      .optional(),
  })
  .passthrough();

const SPRITE_SHEET_BACKGROUND_OPTIONS_SCHEMA = z
  .object({
    jobId: z.string().min(1),
    videoPath: z.string().min(1),
    outputDir: z.string(),
    commands: z.array(z.array(z.string())),
  })
  .passthrough();

const DROPPED_FILE_SCHEMA = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    size: z.number().finite().nonnegative(),
    buffer: BINARY_BUFFER_SCHEMA,
  })
  .passthrough();

const WHISPER_OPTIONS_SCHEMA = z
  .object({
    model: z
      .enum([
        'tiny',
        'base',
        'small',
        'medium',
        'large',
        'large-v2',
        'large-v3',
      ])
      .optional(),
    language: z.string().min(1).optional(),
    translate: z.boolean().optional(),
    device: z.enum(['cpu', 'cuda']).optional(),
    computeType: z.enum(['int8', 'int16', 'float16', 'float32']).optional(),
    beamSize: z.number().int().positive().optional(),
    vad: z.boolean().optional(),
  })
  .passthrough();

const NOISE_REDUCTION_OPTIONS_SCHEMA = z
  .object({
    stationary: z.boolean().optional(),
    propDecrease: z.number().finite().optional(),
    nFft: z.number().int().positive().optional(),
    engine: z.enum(['ffmpeg', 'deepfilter']).optional(),
  })
  .passthrough();

const TRANSCODE_START_OPTIONS_SCHEMA = z
  .object({
    mediaId: z.string().min(1),
    inputPath: z.string().min(1),
    videoBitrate: z.string().optional(),
    audioBitrate: z.string().optional(),
    crf: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const IPC_INVOKE_ARG_SCHEMAS: Record<string, ZodType<unknown[]>> = {
  [IPC_CHANNELS.APP_EXIT_DECISION]: z.tuple([APP_EXIT_DECISION_SCHEMA]),
  [IPC_CHANNELS.GET_MAXIMIZE_STATE]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.SET_TITLEBAR_OVERLAY]: z.tuple([TITLEBAR_OVERLAY_SCHEMA]),
  [IPC_CHANNELS.SET_WINDOW_FULLSCREEN]: z.tuple([z.boolean()]),
  [IPC_CHANNELS.MEDIA_ENSURE_SERVER]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.STARTUP_MARK]: z.union([
    z.tuple([z.string().min(1)]),
    z.tuple([z.string().min(1), RECORD_SCHEMA]),
  ]),
  [IPC_CHANNELS.STARTUP_GET_STATE]: EMPTY_ARGS_SCHEMA,

  [IPC_CHANNELS.OPEN_FILE_DIALOG]: z.union([
    EMPTY_ARGS_SCHEMA,
    z.tuple([OPEN_FILE_DIALOG_OPTIONS_SCHEMA]),
  ]),
  [IPC_CHANNELS.SHOW_SAVE_DIALOG]: z.union([
    EMPTY_ARGS_SCHEMA,
    z.tuple([SAVE_DIALOG_OPTIONS_SCHEMA]),
  ]),
  [IPC_CHANNELS.GET_DOWNLOADS_DIRECTORY]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.SHOW_ITEM_IN_FOLDER]: z.tuple([z.string().min(1)]),

  [IPC_CHANNELS.RUNTIME_STATUS]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.RUNTIME_DOWNLOAD]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.RUNTIME_CANCEL_DOWNLOAD]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.RUNTIME_VERIFY]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.RUNTIME_REMOVE]: EMPTY_ARGS_SCHEMA,

  [IPC_CHANNELS.RELEASE_CHECK_UPDATES]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.RELEASE_GET_UPDATE_CACHE]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.RELEASE_GET_INSTALLED_RELEASE]: EMPTY_ARGS_SCHEMA,

  [IPC_CHANNELS.RUN_FFMPEG]: z.tuple([VIDEO_EDIT_JOB_SCHEMA]),
  [IPC_CHANNELS.RUN_FFMPEG_WITH_PROGRESS]: z.tuple([VIDEO_EDIT_JOB_SCHEMA]),
  [IPC_CHANNELS.EXTRACT_AUDIO_FROM_VIDEO]: z.union([
    z.tuple([z.string().min(1)]),
    z.tuple([z.string().min(1), z.string()]),
  ]),
  [IPC_CHANNELS.RUN_CUSTOM_FFMPEG]: z.tuple([z.array(z.string()), z.string()]),
  [IPC_CHANNELS.GENERATE_SPRITE_SHEET_BACKGROUND]: z.tuple([
    SPRITE_SHEET_BACKGROUND_OPTIONS_SCHEMA,
  ]),
  [IPC_CHANNELS.GET_SPRITE_SHEET_PROGRESS]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.CANCEL_SPRITE_SHEET_JOB]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.PROCESS_DROPPED_FILES]: z.tuple([z.array(DROPPED_FILE_SCHEMA)]),
  [IPC_CHANNELS.CLEANUP_TEMP_FILES]: z.tuple([z.array(z.string().min(1))]),
  [IPC_CHANNELS.READ_FILE]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.READ_FILE_AS_BUFFER]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.GET_IO_STATUS]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.CANCEL_MEDIA_TASKS]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.CREATE_PREVIEW_URL]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.GET_FILE_STREAM]: z.union([
    z.tuple([z.string().min(1)]),
    z.tuple([z.string().min(1), z.number().int().nonnegative()]),
    z.tuple([
      z.string().min(1),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ]),
  ]),
  [IPC_CHANNELS.GET_MEDIA_CACHE_DIR]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.MEDIA_PATH_EXISTS]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.FFMPEG_DETECT_FRAME_RATE]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.FFMPEG_GET_DURATION]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.GET_VIDEO_DIMENSIONS]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.FFMPEG_RUN]: z.tuple([VIDEO_EDIT_JOB_SCHEMA]),
  [IPC_CHANNELS.FFMPEG_CANCEL_EXPORT]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.GENERATE_PROXY]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.GET_HARDWARE_CAPABILITIES]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.FFMPEG_STATUS]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.WHISPER_TRANSCRIBE]: z.union([
    z.tuple([z.string().min(1)]),
    z.tuple([z.string().min(1), WHISPER_OPTIONS_SCHEMA]),
  ]),
  [IPC_CHANNELS.WHISPER_CANCEL]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.WHISPER_STATUS]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.MEDIA_TOOLS_NOISE_REDUCE]: z.union([
    z.tuple([z.string().min(1), z.string().min(1)]),
    z.tuple([
      z.string().min(1),
      z.string().min(1),
      NOISE_REDUCTION_OPTIONS_SCHEMA,
    ]),
  ]),
  [IPC_CHANNELS.MEDIA_TOOLS_CANCEL]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.MEDIA_TOOLS_STATUS]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.NOISE_REDUCTION_GET_OUTPUT_PATH]: z.union([
    z.tuple([z.string().min(1)]),
    z.tuple([z.string().min(1), z.string().min(1)]),
  ]),
  [IPC_CHANNELS.NOISE_REDUCTION_CLEANUP_FILES]: z.tuple([
    z.array(z.string().min(1)),
  ]),
  [IPC_CHANNELS.NOISE_REDUCTION_CREATE_PREVIEW_URL]: z.tuple([
    z.string().min(1),
  ]),
  [IPC_CHANNELS.MEDIA_HAS_AUDIO]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.TRANSCODE_REQUIRES_TRANSCODING]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.TRANSCODE_START]: z.tuple([TRANSCODE_START_OPTIONS_SCHEMA]),
  [IPC_CHANNELS.TRANSCODE_STATUS]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.TRANSCODE_CANCEL]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.TRANSCODE_CANCEL_FOR_MEDIA]: z.tuple([z.string().min(1)]),
  [IPC_CHANNELS.TRANSCODE_GET_ACTIVE_JOBS]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.TRANSCODE_CLEANUP]: z.union([
    EMPTY_ARGS_SCHEMA,
    z.tuple([z.number().finite().nonnegative()]),
  ]),
};

export const IPC_SEND_ARG_SCHEMAS: Record<string, ZodType<unknown[]>> = {
  [IPC_CHANNELS.CLOSE_BTN]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.REQUEST_APP_EXIT]: z.union([
    EMPTY_ARGS_SCHEMA,
    z.tuple([z.string().min(1)]),
  ]),
  [IPC_CHANNELS.MINIMIZE_BTN]: EMPTY_ARGS_SCHEMA,
  [IPC_CHANNELS.MAXIMIZE_BTN]: EMPTY_ARGS_SCHEMA,
};

export type IpcValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export const formatIpcValidationIssues = (
  error: ZodError,
): IpcValidationIssue[] => {
  return error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.join('.') || '(root)',
  }));
};

export const createIpcValidationErrorResponse = (
  channel: string,
  error: ZodError,
) => ({
  success: false as const,
  error: `Invalid IPC payload for channel "${channel}"`,
  code: 'IPC_VALIDATION_ERROR',
  details: formatIpcValidationIssues(error),
});

export const createIpcMissingSchemaErrorResponse = (channel: string) => ({
  success: false as const,
  error: `IPC schema is not defined for channel "${channel}"`,
  code: 'IPC_SCHEMA_MISSING',
});
