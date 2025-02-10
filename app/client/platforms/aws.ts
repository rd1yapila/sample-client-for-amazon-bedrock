"use client";

import {
  ApiPath,
  DEFAULT_API_HOST,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";
import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import Locale from "../../locales";
import {
  ChatOptions,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
} from "../api";
import {
  getMessageTextContent,
  isVisionModel,
} from "@/app/utils";
import {
  isCognitoAKSKExpiration,
  redirectCognitoLoginPage,
  getCognitoRefreshToken,
  refreshCognitoAuthentication,
} from "./aws_cognito";

export interface AWSListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

// AWS Bedrock Client
class BedrockClient {
  private client: BedrockRuntimeClient;

  constructor(config: any) {
    this.client = new BedrockRuntimeClient(config);
  }

  async invokeModel(params: any) {
    const command = new InvokeModelCommand(params);
    return await this.client.send(command);
  }

  async invokeModelWithResponseStream(params: any) {
    const command = new InvokeModelWithResponseStreamCommand(params);
    return await this.client.send(command);
  }
}

export class ClaudeApi implements LLMApi {
  path(path: string): string {
    return "https://facked-url.bedrock.com";
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  convertMessagePayload(
    messages: any,
    modelConfig: any,
    model_version: string,
  ): any {
    var new_messages: any = [];
    var has_system_prompt = false;
    var system_prompt = "";
    var prev_role = "";

    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") {
        if (!has_system_prompt) {
          if (typeof messages[i].content === "string") {
            has_system_prompt = true;
            system_prompt = messages[i].content || ".'";
          }
        }
      } else if (messages[i].role === "user" || messages[i].role === "assistant") {
        var new_contents = [];

        if (prev_role === messages[i].role) {
          const last_message = new_messages.pop();
          for (var k = 0; k < last_message.content.length; k++) {
            new_contents.push(last_message.content[k]);
          }
        }

        if (typeof messages[i].content === "string") {
          const text_payload = { 
            type: "text", 
            text: messages[i].content || "' '" 
          };
          new_contents.push(text_payload);
        } else {
          for (var j = 0; j < messages[i].content.length; j++) {
            if ((messages[i].content[j] as MultimodalContent).type === "image_url") {
              const current_content = messages[i].content[j] as MultimodalContent;
              if (current_content.image_url !== undefined) {
                const image_data_in_string = current_content.image_url.url;
                const image_metadata = image_data_in_string.split(",")[0];
                const image_data = image_data_in_string.split(",")[1];
                const media_type = image_metadata.split(";")[0].split(":")[1];

                const image_payload = {
                  "image": {
                    "format": media_type.split("/")[1],
                    "source": {
                      "bytes": Uint8Array.from(atob(image_data), c => c.charCodeAt(0))
                    }
                  }
                };
                new_contents.push(image_payload);
              }
            } else if ((messages[i].content[j] as MultimodalContent).type === "doc") {
              const doc_payload = {
                "document": (messages[i].content[j] as MultimodalContent).doc
              };
              new_contents.push(doc_payload);
            } else {
              new_contents.push(messages[i].content[j] || "' '");
            }
          }
        }

        new_messages.push({ role: messages[i].role, content: new_contents });
        prev_role = messages[i].role;
      }
    }

    if (new_messages.length > 0 && new_messages[0].role === "assistant") {
      new_messages.unshift({
        role: "user",
        content: [{ type: 'text', text: 'hi' }]
      });
    }

    return {
      ...(has_system_prompt ? { system: system_prompt } : {}),
      messages: new_messages,
      top_p: modelConfig.top_p,
      temperature: modelConfig.temperature,
      max_tokens: modelConfig.max_tokens,
      anthropic_version: model_version,
    };
  }

  async chat(options: ChatOptions) {
    const visionModel = isVisionModel(options.config.model);

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const models = useAppConfig.getState().models;
    const accessStore = useAccessStore.getState();
    let credential;

    // Handle AWS Cognito authentication
    if (accessStore.awsCognitoUser && isCognitoAKSKExpiration()) {
      const refreshToken = getCognitoRefreshToken();
      if (refreshToken) {
        credential = await refreshCognitoAuthentication(refreshToken).then(
          (data) => {
            if (data.credential) {
              const credential = data.credential;
              accessStore.update((access: any) => {
                access.awsRegion = credential.awsRegion;
                access.awsAccessKeyId = credential.awsAccessKeyId;
                access.awsSecretAccessKey = credential.awsSecretAccessKey;
                access.awsSessionToken = credential.awsSessionToken;
                access.awsCognitoUser = true;
              });
              return credential;
            }
          },
        );

        if (!credential) {
          options.onError?.(new Error("AWS credentials expired, auto re-logging..."));
          redirectCognitoLoginPage();
          return;
        }
      } else {
        options.onError?.(new Error("AWS credentials expired, auto re-logging..."));
        redirectCognitoLoginPage();
        return;
      }
    }

    // Verify AWS credentials
    if (!accessStore.awsRegion || !accessStore.awsAccessKeyId || !accessStore.awsSecretAccessKey) {
      options.onFinish(Locale.Error.Unauthorized);
      return;
    }

    const BEDROCK_ENDPOINT = accessStore.bedrockEndpoint || process.env.NEXT_PUBLIC_BEDROCK_ENDPOINT;

    const aws_config = {
      region: accessStore.awsRegion,
      credentials: {
        accessKeyId: credential?.awsAccessKeyId || accessStore.awsAccessKeyId,
        secretAccessKey: credential?.awsSecretAccessKey || accessStore.awsSecretAccessKey,
        sessionToken: credential?.awsSessionToken || accessStore.awsSessionToken,
      },
      ...(BEDROCK_ENDPOINT && { endpoint: BEDROCK_ENDPOINT }),
    };

    const client = new BedrockClient(aws_config);

    const messages = options.messages.map((v) => ({
      role: v.role,
      content: visionModel ? v.content : getMessageTextContent(v),
    }));

    const currentModel = models.find((v) => v.name === modelConfig.model);
    const modelID = currentModel?.modelId;
    const modelVersion = currentModel?.anthropic_version;

    if (!modelID || !modelVersion) {
      throw new Error(`Could not find modelID or modelVersion.`);
    }

    const requestPayload = this.convertMessagePayload(
      messages,
      modelConfig,
      modelVersion,
    );

    if (visionModel) {
      requestPayload.max_tokens = modelConfig.max_tokens;
    }

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      let metrics: any = {};

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;

        function animateResponseText() {
          if (finished || controller.signal.aborted) {
            responseText += remainText;
            return;
          }

          if (remainText.length > 0) {
            const fetchCount = Math.max(1, Math.round(remainText.length / 60));
            const fetchText = remainText.slice(0, fetchCount);
            responseText += fetchText;
            remainText = remainText.slice(fetchCount);
            options.onUpdate?.(responseText, fetchText);
          }

          requestAnimationFrame(animateResponseText);
        }

        animateResponseText();

        const finish = () => {
          if (!finished) {
            finished = true;
            options.onFinish(responseText + remainText, metrics);
          }
        };

        controller.signal.onabort = finish;

        try {
          const payload = {
            modelId: modelID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              anthropic_version: modelVersion,
              ...(requestPayload.system ? { system: requestPayload.system } : {}),
              messages: requestPayload.messages,
              max_tokens: requestPayload.max_tokens,
              temperature: requestPayload.temperature,
              top_p: requestPayload.top_p
            })
          };

          const response = await client.invokeModelWithResponseStream(payload);

          for await (const chunk of response.body) {
            if (chunk.chunk?.bytes) {
              const jsonString = new TextDecoder().decode(chunk.chunk.bytes);
              const jsonResponse = JSON.parse(jsonString);
              if (jsonResponse.completion) {
                remainText += jsonResponse.completion;
              }
            }
          }
          finish();
        } catch (err) {
          finish();
          console.log(`Stream processing error: ${err}`);
        }

      } else {
        const payload = {
          modelId: modelID,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            anthropic_version: modelVersion,
            ...(requestPayload.system ? { system: requestPayload.system } : {}),
            messages: requestPayload.messages,
            max_tokens: requestPayload.max_tokens,
            temperature: requestPayload.temperature,
            top_p: requestPayload.top_p
          })
        };

        const response = await client.invokeModel(payload);
        clearTimeout(requestTimeoutId);

        const responseBody = new TextDecoder().decode(response.body);
        const jsonResponse = JSON.parse(responseBody);

        const message = jsonResponse.completion || "No message returned";
        metrics = jsonResponse.usage || {};
        options.onFinish(message, metrics);
      }
    } catch (e) {
      console.log("[Request] Chat request failed", e);
      options.onError?.(e as Error);
    }
  }

  async usage(): Promise<LLMUsage> {
    return {
      used: 1000,
      total: 1000,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
