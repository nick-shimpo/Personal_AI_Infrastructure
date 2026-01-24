# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#     "faster-whisper>=1.0.0",
# ]
# ///
"""
extract-transcript.py - Local audio transcription using faster-whisper

Usage:
    uv run extract-transcript.py <audio_file>                    # Transcribe to stdout
    uv run extract-transcript.py <audio_file> -o output.txt      # Transcribe to file
    uv run extract-transcript.py <folder> --batch                # Batch transcribe folder
    uv run extract-transcript.py <audio_file> --model small.en   # Use specific model

Models (auto-downloaded on first use):
    tiny.en   - 75MB, fastest, basic accuracy
    base.en   - 150MB, fast, good accuracy (default)
    small.en  - 500MB, medium speed, very good accuracy
    medium    - 1.5GB, slow, excellent accuracy
    large-v3  - 3GB, slowest, best accuracy

Supported formats: m4a, mp3, wav, flac, ogg, aac, wma, mp4, mov, avi, mkv, webm, flv
"""

import argparse
import sys
import os
from pathlib import Path


AUDIO_EXTENSIONS = {'.m4a', '.mp3', '.wav', '.flac', '.ogg', '.aac', '.wma'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'}
ALL_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS


def transcribe_file(filepath: str, model_name: str = "base.en", output_path: str | None = None) -> str:
    """Transcribe a single audio/video file and return the text."""
    from faster_whisper import WhisperModel

    # Load model (cached after first download)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    # Transcribe
    segments, info = model.transcribe(filepath, beam_size=5)

    # Collect all text
    full_text = ""
    for segment in segments:
        full_text += segment.text

    # Clean up whitespace
    full_text = full_text.strip()

    # Output
    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(full_text)
        print(f"Transcript saved to: {output_path}", file=sys.stderr)
    else:
        print(full_text)

    return full_text


def batch_transcribe(folder: str, model_name: str = "base.en") -> None:
    """Transcribe all audio/video files in a folder."""
    folder_path = Path(folder)

    if not folder_path.is_dir():
        print(f"Error: {folder} is not a directory", file=sys.stderr)
        sys.exit(1)

    files = [f for f in folder_path.iterdir() if f.suffix.lower() in ALL_EXTENSIONS]

    if not files:
        print(f"No audio/video files found in {folder}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(files)} file(s) to transcribe", file=sys.stderr)

    for i, filepath in enumerate(sorted(files), 1):
        output_path = filepath.with_suffix('.txt')
        print(f"\n[{i}/{len(files)}] Transcribing: {filepath.name}", file=sys.stderr)
        transcribe_file(str(filepath), model_name, str(output_path))

    print(f"\nDone! Transcribed {len(files)} file(s)", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe audio/video files using faster-whisper (local, offline, free)"
    )
    parser.add_argument("input", help="Audio/video file or folder (with --batch)")
    parser.add_argument("-o", "--output", help="Output file path (default: stdout)")
    parser.add_argument("--model", default="base.en",
                        choices=["tiny.en", "base.en", "small.en", "medium", "large-v3"],
                        help="Whisper model to use (default: base.en)")
    parser.add_argument("--batch", action="store_true",
                        help="Batch process all audio files in a folder")

    args = parser.parse_args()

    # Validate input exists
    if not os.path.exists(args.input):
        print(f"Error: {args.input} does not exist", file=sys.stderr)
        sys.exit(1)

    if args.batch:
        batch_transcribe(args.input, args.model)
    else:
        if not os.path.isfile(args.input):
            print(f"Error: {args.input} is not a file (use --batch for folders)", file=sys.stderr)
            sys.exit(1)

        ext = Path(args.input).suffix.lower()
        if ext not in ALL_EXTENSIONS:
            print(f"Error: Unsupported format '{ext}'. Supported: {', '.join(sorted(ALL_EXTENSIONS))}", file=sys.stderr)
            sys.exit(1)

        transcribe_file(args.input, args.model, args.output)


if __name__ == "__main__":
    main()
