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
    fm.add_argument('--dense',       action='store_true',
                    help='Dense sampling (~1 frame/2.5s) — for verifying short downloaded clips')

    # =========================================================================
    # Organize-media subcommand — plan media-library folder organization
    # =========================================================================
    om = subparsers.add_parser('organize-media', help='Plan how to sort the media library into folders')
    om.add_argument('--input',     required=True, help='Path to inventory JSON (list of media items)')
    om.add_argument('--no-vision', action='store_true', dest='no_vision',
                    help='Name pass only — skip the frame-reference vision pass')

    # =========================================================================
    # Rack-focus subcommand — depth-plane focus pull (near↔far)
    # =========================================================================
    # Stabilize subcommand — camera-shake compensation (no zoom, no crop)
    # =========================================================================
    st = subparsers.add_parser('stabilize', help='Video stabilization: analyze motion / bake offsets / measure shake')
    st.add_argument('--mode',      dest='stab_mode', required=True, choices=['analyze', 'bake', 'measure'])
    st.add_argument('--input',     required=True)
    st.add_argument('--output',    default='', help='analyze: offsets JSON path; bake: output video path')
    st.add_argument('--offsets',   default='', help='bake: offsets JSON from analyze')
    st.add_argument('--smoothing', type=float, default=2.0, help='camera-path low-pass window in seconds')

    # =========================================================================
    rv = subparsers.add_parser('reverb-process', help='Reverb Processor — de-reverb (amount<0) or add convolution reverb (amount>0)')
    rv.add_argument('--input',  required=True)
    rv.add_argument('--output', required=True)
    rv.add_argument('--amount', type=float, required=True, help='-50..+50, 0 = no-op')

    rf = subparsers.add_parser('rack-focus', help='Rack focus — focus travels between depth planes')
    rf.add_argument('--input',     required=True)
    rf.add_argument('--output',    required=True)
    rf.add_argument('--start',     type=float, required=True, help='Region start (seconds)')
    rf.add_argument('--end',       type=float, required=True, help='Region end (seconds)')
    rf.add_argument('--direction', type=str, default='near-to-far',
                    choices=['near-to-far', 'far-to-near'])
    rf.add_argument('--strength',  type=float, default=70.0, help='Max defocus blur 10..100')
    rf.add_argument('--hold',      type=float, default=0.35,
                    help='Seconds to hold focus at each end before/after the pull')
    rf.add_argument('--from-subject', type=str, default='', dest='from_subject',
                    help='Subject initially in focus (natural description, vision-located)')
    rf.add_argument('--to-subject',   type=str, default='', dest='to_subject',
                    help='Subject focus travels to (natural description, vision-located)')

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
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help="Device to use (default: auto — GPU first, CPU fallback)"
    )
    transcribe_parser.add_argument(
        "--compute-type",
        choices=["auto", "int8", "int16", "float16", "float32"],
        default="auto",
        help="Compute type (default: auto — float16 on GPU, int8 on CPU)"
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

        elif args.command == "find-moment":
            from scripts import find_moment
            find_moment.handle_args(args)

        elif args.command == "rack-focus":
            from scripts import rack_focus
            rack_focus.handle_args(args)

        elif args.command == "stabilize":
            from scripts import stabilize
            stabilize.handle_args(args)

        elif args.command == "reverb-process":
            from scripts import reverb_processor
            reverb_processor.handle_args(args)

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
