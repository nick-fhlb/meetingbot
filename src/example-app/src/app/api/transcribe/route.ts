import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: Request) {
  try {
    // Check if API key is available
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OpenAI API key is not configured' }, { status: 500 });
    }

    // Initialize OpenAI client only when needed
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const { recordingUrl } = await req.json();
    
    if (!recordingUrl) {
      return NextResponse.json({ error: 'Recording URL is required' }, { status: 400 });
    }

    // Validate URL format
    try {
      new URL(recordingUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid recording URL format' }, { status: 400 });
    }

    // Download the audio file from the URL
    const response = await fetch(recordingUrl);
    
    if (!response.ok) {
      return NextResponse.json({ 
        error: `Failed to fetch recording: ${response.status} ${response.statusText}` 
      }, { status: 400 });
    }

    const audioBuffer = await response.arrayBuffer();
    
    // Validate file size (max 25MB for OpenAI Whisper)
    const maxSize = 25 * 1024 * 1024; // 25MB in bytes
    if (audioBuffer.byteLength > maxSize) {
      return NextResponse.json({ 
        error: `File too large. Maximum size is 25MB, got ${Math.round(audioBuffer.byteLength / 1024 / 1024)}MB` 
      }, { status: 400 });
    }

    // Validate file size (minimum 1KB)
    if (audioBuffer.byteLength < 1024) {
      return NextResponse.json({ 
        error: 'File too small. Minimum size is 1KB' 
      }, { status: 400 });
    }

    const audioBlob = new Blob([audioBuffer]);
    
    // Validate file format by checking content type
    const contentType = response.headers.get('content-type');
    const supportedTypes = [
      'audio/mpeg',
      'audio/mp3', 
      'audio/wav',
      'audio/mp4',
      'audio/m4a',
      'audio/webm',
      'audio/ogg',
      'video/mp4',
      'video/webm'
    ];
    
    if (contentType && !supportedTypes.some(type => contentType.includes(type))) {
      return NextResponse.json({ 
        error: `Unsupported file format: ${contentType}. Supported formats: ${supportedTypes.join(', ')}` 
      }, { status: 400 });
    }
    
    // Transcribe with Whisper (not our own model)
    const transcriptionResponse = await openai.audio.transcriptions.create({
      file: new File([audioBlob], 'recording.mp4'),
      model: 'whisper-1',
    });
    
    const transcription = transcriptionResponse.text;
    
    // Generate summary with GPT-4o (not our own model)
    const summaryResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that summarizes meeting transcripts.'
        },
        {
          role: 'user',
          content: `Please provide a concise summary of this meeting transcript: ${transcription}`
        }
      ],
    });
    
    const summary = summaryResponse.choices[0]?.message?.content;
    
    return NextResponse.json({ transcription, summary }, { status: 200 });
  } catch (error) {
    console.error('Error in transcription or summarization:', error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : 'An unknown error occurred' 
    }, { status: 500 });
  }
} 
