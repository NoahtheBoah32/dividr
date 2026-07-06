"""
DiviDr Tools - Unified media processing binary
Supports transcription and noise reduction via CLI subcommands

Usage:
    dividr-tools transcribe --input <file> --output <file> [options]
    dividr-tools transcribe --input <file> --output - [options]  # stdout
    dividr-tools noise-reduce --input <file> --output <file> [options]
    dividr-tools --version
"""

import argparse
import json
import sys

__version__ = "1.0.0"


def main():
    parser = argparse.ArgumentParser(
        prog="dividr-tools",
        description="DiviDr unified media processing tools"
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}"
    )

    subparsers = parser.add_subparsers(
        dest="command",
        title="commands",
        description="Available commands",
        help="Run 'dividr-tools <command> --help' for more info"
    )

    # =========================================================================
    # Face-zoom subcommand (args registered statically — module loaded lazily)
    # =========================================================================
    fz = subparsers.add_parser('face-zoom', help='Face-tracking smooth zoom')
    fz.add_argument('--input',        required=True)
    fz.add_argument('--output',       required=True)
    fz.add_argument('--start',        type=float, required=True)
    fz.add_argument('--end',          type=float, required=True)
    fz.add_argument('--zoom',         type=float, default=2.5)
    fz.add_argument('--ease',         type=float, default=0.4)
    fz.add_argument('--sample-every', type=int,   default=6)
    fz.add_argument('--target',       type=str,   default='face',
                    help='Subject to zoom: face (default), ball, vase, bottle, money, etc.')

    # =========================================================================
    # Motion-analyze subcommand
    # =========================================================================
    # Skeleton-render subcommand
    # =========================================================================
    sr = subparsers.add_parser('skeleton-render', help='Render skeleton overlay on video')
    sr.add_argument('--input',  required=True)
    sr.add_argument('--output', required=True)

    # =========================================================================
    ma = subparsers.add_parser('motion-analyze', help='Detect motion events from body pose')
    ma.add_argument('--input',        required=True)
    ma.add_argument('--detect',       type=str, default='punch,jump,energy,speaker',
                    help='Comma-separated list of detectors to run')
    ma.add_argument('--sample-every', type=int, default=3,
                    help='Process every Nth frame (default: 3)')

    # =========================================================================
    # Selective-freeze subcommand — "hold the world, let one thing move"
    # =========================================================================
    sf = subparsers.add_parser('selective-freeze', help='Selective freeze (hold the world, one thing moves)')
    sf.add_argument('--input',     required=True)
    sf.add_argument('--output',    required=True)
    sf.add_argument('--start',     type=float, required=True, help='Region start (seconds)')
    sf.add_argument('--end',       type=float, required=True, help='Region end (seconds)')
    sf.add_argument('--mode',      type=str, default='world-frozen',
                    choices=['world-frozen', 'subject-frozen', 'full'])
    sf.add_argument('--freeze-at', type=float, default=-1.0, dest='freeze_at',
                    help='Source second to freeze the world at (default: region start)')
    sf.add_argument('--click',     type=str, default='',
                    help='Normalized "x,y" (0..1) to select ONE subject (freeze everyone but them)')
    sf.add_argument('--feather',   type=int, default=3, help='Edge feather radius (px)')
    sf.add_argument('--no-fill-world', action='store_true', dest='no_fill_world',
                    help='subject-frozen: skip erasing the live subject from the moving world')

    # =========================================================================
    # Motion-freeze subcommand — "hold the world" rebuilt as a motion key (no matte)
    # =========================================================================
    mfz = subparsers.add_parser('motion-freeze', help='Motion-key selective freeze (no background remover)')
    mfz.add_argument('--input',     required=True)
    mfz.add_argument('--output',    required=True)
    mfz.add_argument('--start',     type=float, required=True, help='Region start (seconds)')
    mfz.add_argument('--end',       type=float, required=True, help='Region end (seconds)')
    mfz.add_argument('--mode',      type=str, default='freezeWorld',
                     choices=['freezeWorld', 'freezeSubject', 'freezeAll'])
    mfz.add_argument('--freeze-at', type=float, default=-1.0, dest='freeze_at',
                     help='Source second to hold at (default: region start)')
    mfz.add_argument('--box',       type=str, default='',
                     help='Region box: "" | rect:x,y,w,h | lasso:[[x,y],..] | yolo:<class> (normalized)')
    mfz.add_argument('--hi',        type=float, default=22.0, help='Motion threshold high')
    mfz.add_argument('--lo',        type=float, default=10.0, help='Motion threshold low')

    # =========================================================================
    # Find-moment subcommand — "CTRL-F for video" (object/visual search)
    # =========================================================================
    fm = subparsers.add_parser('find-moment', help='Find a described moment in a clip (object/visual)')
    fm.add_argument('--input',       required=True)
    fm.add_argument('--target',      type=str, required=True,
                    help='What to find: a COCO object (car, dog, person...) or "motion"')
    fm.add_argument('--interval',    type=float, default=0.5, help='Sample every N seconds')
    fm.add_argument('--start',       type=float, default=0.0, help='Search from this second')
    fm.add_argument('--find-all',    action='store_true', dest='find_all',
                    help='Return every match instead of the first')

    # =========================================================================
    # Organize-media subcommand — plan media-library folder organization
    # =========================================================================
    om = subparsers.add_parser('organize-media', help='Plan how to sort the media library into folders')
    om.add_argument('--input',     required=True, help='Path to inventory JSON (list of media items)')
    om.add_argument('--no-vision', action='store_true', dest='no_vision',
                    help='Name pass only — skip the frame-reference vision pass')

    # =========================================================================
    # Regional-speed subcommand — "speed that lives inside the clip"
    # =========================================================================
    rs = subparsers.add_parser('regional-speed', help='Per-region speed inside one frame')
    rs.add_argument('--input',   required=True)
    rs.add_argument('--output',  required=True)
    rs.add_argument('--start',   type=float, required=True, help='Region start (seconds)')
    rs.add_argument('--end',     type=float, required=True, help='Region end (seconds)')
    rs.add_argument('--speed',   type=float, default=0.5, help='Speed for the brushed region (e.g. 0.25)')
    rs.add_argument('--region',  type=str, required=True,
                    help='Region as "x,y,w,h" | "ellipse:cx,cy,rx,ry" | "lasso:[[x,y],..]" normalized (0..1)')
    rs.add_argument('--feather', type=int, default=24, help='Region edge feather (px)')
    rs.add_argument('--invert',  action='store_true',
                    help='Slow the COMPLEMENT of the region (keep the drawn subject real-time)')

    # =========================================================================
    # Voice-separate subcommand — true 2-stem split (voice + background)
    # =========================================================================
    vs = subparsers.add_parser('voice-separate', help='Separate voice and background stems')
    vs.add_argument('--input',        required=True)
    vs.add_argument('--output',       required=True, help='Voice stem output (.wav)')
    vs.add_argument('--instrumental', default='', help='Background stem output (.wav)')
    vs.add_argument('--model',        default='', help='Path to a separation .onnx (optional)')

    # =========================================================================
    # Transcribe subcommand
    # =========================================================================
    transcribe_parser = subparsers.add_parser(
        "transcribe",
        help="Transcribe audio/video files using Faster-Whisper"
    )
    transcribe_parser.add_argument(
        "--input",
        required=True,
        help="Path to input audio/video file"
    )
    transcribe_parser.add_argument(
        "--output",
        required=True,
        help="Path to output JSON file (use '-' for stdout)"
    )
    transcribe_parser.add_argument(
        "--model",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        default="large-v3",
        help="Whisper model size (default: large-v3)"
    )
    transcribe_parser.add_argument(
        "--language",
        default=None,
        help="Language code (e.g., 'en', 'es'). Auto-detect if not specified"
    )
    transcribe_parser.add_argument(
        "--translate",
        action="store_true",
        help="Translate to English"
    )
    transcribe_parser.add_argument(
        "--device",
        choices=["cpu", "cuda"],
        default="cpu",
        help="Device to use (default: cpu)"
    )
    transcribe_parser.add_argument(
        "--compute-type",
        choices=["int8", "int16", "float16", "float32"],
        default="int8",
        help="Compute type (default: int8)"
    )
    transcribe_parser.add_argument(
        "--beam-size",
        type=int,
        default=5,
        help="Beam size for decoding (default: 5)"
    )
    transcribe_parser.add_argument(
        "--no-vad",
        action="store_true",
        help="Disable voice activity detection"
    )

    # =========================================================================
    # Noise-reduce subcommand
    # =========================================================================
    noise_parser = subparsers.add_parser(
        "noise-reduce",
        help="Reduce background noise from audio files"
    )
    noise_parser.add_argument(
        "--input",
        required=True,
        help="Path to input audio file (.wav format recommended)"
    )
    noise_parser.add_argument(
        "--output",
        required=True,
        help="Path to output audio file (.wav format)"
    )
    noise_parser.add_argument(
        "--stationary",
        action="store_true",
        default=True,
        help="Assume noise is stationary (default: True)"
    )
    noise_parser.add_argument(
        "--non-stationary",
        action="store_false",
        dest="stationary",
        help="Assume noise is non-stationary"
    )
    noise_parser.add_argument(
        "--prop-decrease",
        type=float,
        default=0.8,
        help="Proportion of noise to reduce (0.0-1.0, default: 0.8)"
    )
    noise_parser.add_argument(
        "--n-fft",
        type=int,
        default=2048,
        help="FFT window size (default: 2048)"
    )

    # Parse arguments
    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    # Route to appropriate handler — all imports are lazy so unrelated heavy
    # dependencies (faster-whisper, torch, etc.) don't load for other commands.
    try:
        if args.command == "transcribe":
            from scripts import transcribe
            transcribe_kwargs = {
                "model_size": args.model,
                "device": args.device,
                "compute_type": args.compute_type.replace("-", "_"),
                "beam_size": args.beam_size,
                "vad_filter": not args.no_vad,
            }
            if args.language:
                transcribe_kwargs["language"] = args.language
            if args.translate:
                transcribe_kwargs["translate"] = True

            if args.output == "-":
                result = transcribe.transcribe_audio(args.input, **transcribe_kwargs)
                result_json = json.dumps(result)
                print(f"RESULT|{result_json}", flush=True)
            else:
                transcribe.run(args.input, args.output, **transcribe_kwargs)

        elif args.command == "noise-reduce":
            from scripts import noisereduction
            noisereduction.run(args.input, args.output)

        elif args.command == "face-zoom":
            from scripts import facezoom
            facezoom.handle_args(args)

        elif args.command == "skeleton-render":
            from scripts import skeletonrender
            skeletonrender.handle_args(args)

        elif args.command == "motion-analyze":
            from scripts import motionanalyze
            motionanalyze.handle_args(args)

        elif args.command == "selective-freeze":
            from scripts import selective_freeze
            selective_freeze.handle_args(args)

        elif args.command == "motion-freeze":
            from scripts import motion_freeze
            motion_freeze.handle_args(args)

        elif args.command == "find-moment":
            from scripts import find_moment
            find_moment.handle_args(args)

        elif args.command == "regional-speed":
            from scripts import regional_speed
            regional_speed.handle_args(args)

        elif args.command == "organize-media":
            from scripts import organize_media
            organize_media.handle_args(args)

        elif args.command == "voice-separate":
            from scripts import voice_separate
            voice_separate.handle_args(args)

        else:
            print(f"Unknown command: {args.command}", file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(f"ERROR|{str(e)}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
