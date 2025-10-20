// app/api/bots/route.ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Validate required fields in request body
    const requiredFields = ['userId', 'meetingTitle', 'meetingInfo', 'callbackUrl'];
    const missingFields = requiredFields.filter(field => !body[field]);
    
    if (missingFields.length > 0) {
      return NextResponse.json({ 
        error: `Missing required fields: ${missingFields.join(', ')}` 
      }, { status: 400 });
    }

    // Validate meetingInfo structure
    const { meetingInfo } = body;
    if (!meetingInfo || typeof meetingInfo !== 'object') {
      return NextResponse.json({ 
        error: 'meetingInfo must be a valid object' 
      }, { status: 400 });
    }

    // Validate meetingInfo has required platform field
    if (!meetingInfo.platform) {
      return NextResponse.json({ 
        error: 'meetingInfo must include platform field' 
      }, { status: 400 });
    }

    // Validate callbackUrl format
    const { callbackUrl } = body;
    try {
      new URL(callbackUrl);
    } catch {
      return NextResponse.json({ 
        error: 'callbackUrl must be a valid URL' 
      }, { status: 400 });
    }

    // Get Key
    const key = process.env.BOT_API_KEY;
    if (!key) throw new Error(`Missing required environment variable: BOT_API_KEY`);
    
    const endpoint = process.env.MEETINGBOT_END_POINT;
    if (!endpoint) throw new Error(`Missing required environment variable: MEETINGBOT_END_POINT`);

    //
    // Send request to MeetingBot API to start and send a bot to a meeting
    //
    const eurl = `${endpoint}/api/bots`;
    console.log('Sending Request to', eurl ,'with body', body);

    //Send
    const response = await fetch(eurl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify(body),   
    });

    //
    // Return the response from the MeetingBot API
    //

    const data = await response.json();
    console.log('RECEIVED', data);
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'An unknown error occurred' }, { status: 500 });

  }
}
