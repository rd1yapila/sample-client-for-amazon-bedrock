// copied from Su Wei's code coach project

import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand,
  ConverseCommand,
  ConverseStreamCommand,
  ConverseCommandInput
} from "@aws-sdk/client-bedrock-runtime"; // ES Modules import
import { STS } from "@aws-sdk/client-sts";

import {
  SubmitKey,
  useChatStore,
  Theme,
  useUpdateStore,
  useAccessStore,
  useAppConfig,
} from "@/app/store";
import { MultimodalContent } from "../api";

const AWSRegion = process.env.AWS_REGION ?? "us-west-2";

interface AWSConfigWithCredentials {
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

interface AWSConfigWithRegionOnly {
  region: string;
}

type AWSConfigReturnType = AWSConfigWithCredentials | AWSConfigWithRegionOnly;

interface AuthProps {
  authType?: string;
  akValue?: string;
  skValue?: string;
  awsRegionValue?: string;
}



// const accessStore = useAccessStore();

/**
 * Generates the configuration object for AWS SDK based on the authentication type.
 *
 * @returns {AWSConfigReturnType} The AWS configuration object with either credentials or just the region.
 */
const AWSConfig = (): AWSConfigReturnType => {
  

  return {
    region: AWSRegion,
    credentials: {
      accessKeyId: "accessStore.awsAccessKeyId",
      secretAccessKey: "accessStore.awsSecretAccessKey",
    },
  };
};

class STSClient {
  client: STS;

  constructor(config: AWSConfigReturnType) {
    this.client = new STS(config);
  }

  async getCallerIdentity() {
    return this.client.getCallerIdentity({});
  }
}

class BedrockClient {
  client: BedrockRuntimeClient;

  constructor(config: AWSConfigReturnType) {
    this.client = new BedrockRuntimeClient(config);
  }

  async invokeModelWithStream(payload: any, modelId: string) {
    const input = {
      body: JSON.stringify(payload),
      contentType: "application/json",
      accept: "application/json",
      modelId,
    };
    const command = new InvokeModelWithResponseStreamCommand(input);
    return this.client.send(command);
  }

  async invokeModel(params: {
    modelId: string;
    input: Record<string, any>;
  }) {
    const command = new InvokeModelCommand({
      modelId: params.modelId,
      body: JSON.stringify(params.input),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await this.client.send(command);
    return JSON.parse(new TextDecoder().decode(response.body));
  }

  async invokeModelStream(params: {
    modelId: string;
    input: Record<string, any>;
  }) {
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: params.modelId,
      body: JSON.stringify(params.input),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await this.client.send(command);
    return this.processStream(response.body);
  }

  private async *processStream(stream: ReadableStream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        try {
          yield JSON.parse(chunk);
        } catch (e) {
          yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  
  async converseModel(payload: ConverseCommandInput) {
    console.log("Converse invoke")
     // Create a command with payload.
    const command = new ConverseCommand(payload)
    return this.client.send(command);
  }

  async converseStream(payload: ConverseCommandInput) {

    console.log("ConverseStream invoke",payload)
    
    // Create a command with payload.
    const command = new ConverseStreamCommand(payload)

    return this.client.send(command);

  }

}

export { AWSConfig, BedrockClient, STSClient, AWSRegion };

export type { AuthProps };
