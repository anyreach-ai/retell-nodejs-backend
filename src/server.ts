import express, { Request, Response } from "express";
import expressWs from "express-ws";
import { RawData, WebSocket } from "ws";
import { createServer, Server as HTTPServer } from "http";
import cors from "cors";
import dotenv from 'dotenv';
import { db, admin } from "./firebase"; // Import Firebase
import { CustomLlmRequest, CustomLlmResponse, ResponseRequiredRequest, ReminderRequiredRequest, CallDetailsRequest, Utterance } from "./types";
// import { TwilioClient } from "./twilio_api";
import { Retell } from "retell-sdk";
import RetellClient from 'retell-sdk'; // Adjusted import
import axios from 'axios';

dotenv.config();

// Any one of these following LLM clients can be used to generate responses.
import { FunctionCallingLlmClient } from "./llms/llm_openai_func_call";
// import { DemoLlmClient } from "./llms/llm_azure_openai";
// import { FunctionCallingLlmClient } from "./llms/llm_azure_openai_func_call_end_call";
// import { FunctionCallingLlmClient from "./llms/llm_azure_openai_func_call";
// import { DemoLlmClient from "./llms/llm_openrouter";

let beginSentence = "Hey there, I'm your personal AI therapist, how can I help you?";
let agentPrompt = "Task: As a professional therapist, your responsibilities are comprehensive and patient-centered. You establish a positive and trusting rapport with patients, diagnosing and treating mental health disorders. Your role involves creating tailored treatment plans based on individual patient needs and circumstances. Regular meetings with patients are essential for providing counseling and treatment, and for adjusting plans as needed. You conduct ongoing assessments to monitor patient progress, involve and advise family members when appropriate, and refer patients to external specialists or agencies if required. Keeping thorough records of patient interactions and progress is crucial. You also adhere to all safety protocols and maintain strict client confidentiality. Additionally, you contribute to the practice's overall success by completing related tasks as needed.\n\nConversational Style: Communicate concisely and conversationally. Aim for responses in short, clear prose, ideally under 10 words. This succinct approach helps in maintaining clarity and focus during patient interactions.\n\nPersonality: Your approach should be empathetic and understanding, balancing compassion with maintaining a professional stance on what is best for the patient. It's important to listen actively and empathize without overly agreeing with the patient, ensuring that your professional opinion guides the therapeutic process.";

export class Server {
  private httpServer: HTTPServer;
  public app: expressWs.Application;
  private retellClient: Retell;
  // private twilioClient: TwilioClient;

  constructor() {
    this.app = expressWs(express()).app;
    this.httpServer = createServer(this.app);
    this.app.use(express.json());
    this.app.use(cors());
    this.app.use(express.urlencoded({ extended: true }));

    const retellClient = new RetellClient({
      apiKey: process.env.RETELL_API_KEY,
    });

    this.retellClient = retellClient;
    this.handleRetellLlmWebSocket();
    this.handleRegisterCallAPI();
    this.handleWebhook();
    this.handlePromptAPI();
    this.handleCreateAgentAPI(); // Add create agent API handler

  }

  listen(port: number): void {
    this.app.listen(port);
    console.log("Listening on " + port);
  }

  /* Handle webhook from Retell server. This is used to receive events from Retell server.
     Including call_started, call_ended, call_analyzed */
  handleWebhook() {
    this.app.post("/webhook", (req: Request, res: Response) => {
      if (
        !Retell.verify(
          JSON.stringify(req.body),
          process.env.RETELL_API_KEY,
          req.headers["x-retell-signature"] as string,
        )
      ) {
        console.error("Invalid signature");
        return;
      }
      const content = req.body;
      switch (content.event) {
        case "call_started":
          console.log("Call started event received", content.data.call_id);
          break;
        case "call_ended":
          console.log("Call ended event received", content.data.call_id);
          break;
        case "call_analyzed":
          console.log("Call analyzed event received", content.data.call_id);
          break;
        default:
          console.log("Received an unknown event:", content.event);
      }
      // Acknowledge the receipt of the event
      res.json({ received: true });
    });
  }

  /* Only used for web call frontend to register call so that frontend don't need api key.
     If you are using Retell through phone call, you don't need this API. Because
     this.twilioClient.ListenTwilioVoiceWebhook() will include register-call in its function. */
  handleRegisterCallAPI() {
    this.app.post(
      "/register-call-on-your-server",
      async (req: Request, res: Response) => {
        // Extract agentId from request body; apiKey should be securely stored and not passed from the client
        const { agent_id } = req.body;

        try {
          const callResponse = await this.retellClient.call.createWebCall({
            agent_id: agent_id,
          });

          // Send back the successful response to the client
          res.json(callResponse);
        } catch (error) {
          console.error('Error creating web call:', error);
// Send an error response back to the client
          res.status(500).json({ error: 'Failed to create web call' });
        }
      });
  }

  /* Start a websocket server to exchange text input and output with Retell server. Retell server 
     will send over transcriptions and other information. This server here will be responsible for
     generating responses with LLM and send back to Retell server.*/
  handleRetellLlmWebSocket() {
    this.app.ws(
      "/llm-websocket/:call_id",
      async (ws: WebSocket, req: Request) => {
        try {
          const callId = req.params.call_id;
          console.log("Handle llm ws for: ", callId);

          // Send config to Retell server
          const config: CustomLlmResponse = {
            response_type: "config",
            config: {
              auto_reconnect: true,
              call_details: true,
            },
          };
          ws.send(JSON.stringify(config));

          // Start sending the begin message to signal the client is ready.
          const llmClient = new FunctionCallingLlmClient();

          ws.on("error", (err) => {
            console.error("Error received in LLM websocket client: ", err);
          });
          ws.on("close", (err) => {
            console.error("Closing llm ws for: ", callId);
          });

          ws.on("message", async (data: RawData, isBinary: boolean) => {
            if (isBinary) {
              console.error("Got binary message instead of text in websocket.");
              ws.close(1007, "Cannot find corresponding Retell LLM.");
            }
            const request: CustomLlmRequest = JSON.parse(data.toString());

// Type guards to ensure the request has the 'call' property
            if (isResponseRequiredRequest(request) || isReminderRequiredRequest(request)) {
                            const transcriptData = {
                callId: callId, // Using callId from the URL parameter
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                transcript: request.transcript.map((utt: Utterance) => utt.content)
              };

              await db.collection('transcripts').add(transcriptData);

              llmClient.DraftResponse(request, ws);
            } else if (isCallDetailsRequest(request)) {
// print call details
              console.log("call details: ", request.call);
// Send begin message to start the conversation
              llmClient.BeginMessage(ws);
            } else if (request.interaction_type === "ping_pong") {
              const pingpongResponse: CustomLlmResponse = {
                response_type: "ping_pong",
                timestamp: request.timestamp,
              };
              ws.send(JSON.stringify(pingpongResponse));
            } else if (request.interaction_type === "update_only") {
              // process live transcript update if needed
            }
          });
        } catch (err) {
          console.error("Encountered error:", err);
          ws.close(1011, "Encountered error: " + err);
        }
      },
    );
  }
  handlePromptAPI() {
    this.app.post('/set-prompts', (req: Request, res: Response) => {
      const { newBeginSentence, newAgentPrompt } = req.body;
      if (newBeginSentence) beginSentence = newBeginSentence;
      if (newAgentPrompt) agentPrompt = newAgentPrompt;
      res.json({ message: 'Prompts updated successfully' });
    });

    this.app.get('/get-prompts', (req: Request, res: Response) => {
      res.json({ beginSentence, agentPrompt });
    });
  }

  handleCreateAgentAPI() {
    this.app.post('/create-agent', async (req: Request, res: Response) => {
      const {
        llm_websocket_url,
        agent_name,
        voice_id,
        fallback_voice_ids,
        voice_temperature,
        voice_speed,
        responsiveness,
        interruption_sensitivity,
        enable_backchannel,
        backchannel_frequency,
        backchannel_words,
        reminder_trigger_ms,
        reminder_max_count,
        ambient_sound,
        ambient_sound_volume,
        language,
        webhook_url,
        boosted_keywords,
        opt_out_sensitive_data_storage,
        pronunciation_dictionary,
        normalize_for_speech,
        end_call_after_silence_ms
      } = req.body;

      const apiKey = process.env.RETELL_API_KEY;

      try {
        const response = await axios.post('https://api.retell.com/create-agent', {
          llm_websocket_url,
          agent_name,
          voice_id,
          fallback_voice_ids,
          voice_temperature,
          voice_speed,
          responsiveness,
          interruption_sensitivity,
          enable_backchannel,
          backchannel_frequency,
          backchannel_words,
          reminder_trigger_ms,
          reminder_max_count,
          ambient_sound,
          ambient_sound_volume,
          language,
          webhook_url,
          boosted_keywords,
          opt_out_sensitive_data_storage,
          pronunciation_dictionary,
          normalize_for_speech,
          end_call_after_silence_ms
        }, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });

        res.status(201).json(response.data);
      } catch (error) {
        console.error('Error creating agent:', error);
        res.status(500).json({ error: 'Failed to create agent' });
      }
    });
  }
}

// Type guards
function isResponseRequiredRequest(request: CustomLlmRequest): request is ResponseRequiredRequest {
  return request.interaction_type === 'response_required';
}

function isReminderRequiredRequest(request: CustomLlmRequest): request is ReminderRequiredRequest {
  return request.interaction_type === 'reminder_required';
}

function isCallDetailsRequest(request: CustomLlmRequest): request is CallDetailsRequest {
  return request.interaction_type === 'call_details';
}
