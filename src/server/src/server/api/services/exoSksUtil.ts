// exoSksUtil.ts — small helper for Exoscale SKS ↔︎ Kubernetes

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  type V1Service,
  type V1Container,
  type V1EnvVar,
  type V1Job,
  type V1JobSpec, type V1LabelSelector,
} from '@kubernetes/client-node';
import {type V1PodSpec} from "@kubernetes/client-node/dist/gen/models/V1PodSpec";
import {env} from "~/env";

export interface ExoConfig {
  apiKey: string;
  apiSecret: string;
  /** Exoscale zone slug, e.g. "de-fra-1" */
  zone: string;
  /** SKS cluster UUID */
  clusterId: string;
  /** Kubeconfig user group (defaults to system:masters) */
  group?: string;
  /** Kubeconfig username (defaults to kube-admin) */
  user?: string;
}

/**
 * Fetch a short‑lived kube‑config for the given SKS cluster.
 */
export async function getKubeConfig(): Promise<string> {
  const exo: ExoConfig = {
    apiKey: env.EXO_KEY,
    apiSecret: env.EXO_SECRET,
    zone: env.EXO_ZONE,
    clusterId: env.EXO_CLUSTER_ID,
  }
  const expires = new Date().getTime() + (60 * 60 * 24 * 30); // default 30 days
  const path = `/v2/sks-cluster-kubeconfig/${exo.clusterId}`;
  const url = `https://api-${exo.zone}.exoscale.com${path}`;
  const body = {
    ttl: 60 * 60 * 24 * 30, // default 30 days
    user: 'kube-admin',
    groups: ['system:masters'],
  };
  const method = 'POST';
  const message = `${method} ${path}\n${JSON.stringify(body)}\n\n\n${expires}`;

  const signature = crypto
      .createHmac('sha256', exo.apiSecret)
      .update(message, 'utf8')
      .digest('base64');

  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `EXO2-HMAC-SHA256 credential=${exo.apiKey},expires=${expires},signature=${signature}`,
        'Content-Type': 'application/json',
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (!res.data?.kubeconfig) {
      throw new Error('Exoscale response missing "kubeconfig" field');
    }

    // Decode base64 to YAML string
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const kubeconfigBase64 = res.data.kubeconfig as string;
    try {
      const kubeconfigYaml = Buffer.from(kubeconfigBase64, 'base64').toString('utf-8');
      return kubeconfigYaml;
    } catch (e) {
      // If base64 decoding fails, assume it's already YAML
      console.warn('Failed to decode as base64, assuming YAML format:', e);
      return kubeconfigBase64;
    }
  } catch (e) {
    console.error(e);

    return '';
  }


}

export interface DeployImageOptions {
  /** K8s Deployment & Service name */
  name: string;
  /** Image, fully qualified (e.g. ghcr.io/org/app:tag) */
  image: string;
  /** Namespace, default "default" */
  namespace?: string;
  /** Replica count, default 1 */
  replicas?: number;
  /** Env vars as key–value map */
  env?: Record<string, string|undefined>;
  /** Container port to expose, default 80 */
  containerPort?: number;
  /** When true, creates/updates a LoadBalancer Service */
  expose?: boolean;
  /** TTL in seconds after Job completion before deletion. Set to 0 for immediate deletion (logs will be lost). Default 300 (5 minutes) to allow log collection. */
  ttlSecondsAfterFinished?: number;
}

/**
 * Create or patch a Job (and optional Service) in the cluster.
 * Job configuration:
 * - backoffLimit: 2 means retry 2 more times on startup failure (3 total attempts)
 * - restartPolicy: 'Never' means don't restart if it fails during execution
 * - ttlSecondsAfterFinished: configurable TTL before deletion (default 300s to allow log collection)
 * 
 * NOTE: If ttlSecondsAfterFinished is 0, logs will be lost when the pod is deleted.
 * Consider using a cluster-level logging solution (e.g., Fluentd, Fluent Bit, or similar)
 * to forward logs to a centralized system before pod deletion.
 */
export async function deployImage(opts: DeployImageOptions): Promise<void> {
  const {
    name,
    image,
    namespace = 'default',
    env = {},
    containerPort = 80,
    expose = false,
    ttlSecondsAfterFinished = 300, // Default 5 minutes to allow log collection
  } = opts;

  const kubeConfigYaml = await getKubeConfig();
  // Write kubeconfig to temporary file
  const tempFilePath = join(tmpdir(), `kubeconfig-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  await fs.writeFile(tempFilePath, kubeConfigYaml, 'utf-8');

  try {
    // Initialise clients
    const kc = new KubeConfig();
    kc.loadFromFile(tempFilePath);
    const core = kc.makeApiClient(CoreV1Api);

    const selector: V1LabelSelector = {matchLabels: {app: name}};
    const container: V1Container = {
      name,
      image,
      env: Object.entries(env).map(([k, v]) => {
        const envVar: V1EnvVar = {name: k, value: v?.toString()};

        return envVar;
      }),
      ports: [{containerPort}],
    };
    const templateSpec: V1PodSpec = {
      containers: [
        container
      ],
      restartPolicy: 'Never', // Don't restart if container fails during execution
    };
    
    // Use Job instead of Deployment for better control over retries and cleanup
    // Job configuration:
    // - backoffLimit: 2 means retry 2 more times on failure (3 total attempts)
    // - restartPolicy: 'Never' means don't restart if it fails during execution
    // - ttlSecondsAfterFinished: configurable delay before deletion (default 300s to allow log collection)
    const batch = kc.makeApiClient(BatchV1Api);
    const jobSpec: V1JobSpec = {
      backoffLimit: 2, // Retry 2 more times on startup failure (3 total attempts)
      ttlSecondsAfterFinished: ttlSecondsAfterFinished, // Delay before deletion (0 = immediate, logs will be lost)
      template: {
        metadata: {labels: {app: name}},
        spec: templateSpec,
      },
    };
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name },
      spec: jobSpec,
    };

    // Create or replace Job
    try {
      await batch.readNamespacedJob({name, namespace});
      await batch.replaceNamespacedJob({name, namespace, body: job});
      console.log(`🔄 Updated job ${namespace}/${name}`);
      /* eslint-disable  @typescript-eslint/no-explicit-any */
    } catch (e: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (e?.code === 404) {
        await batch.createNamespacedJob({namespace, body: job});
        console.log(`✅ Created job ${namespace}/${name}`);
      } else {
        throw e;
      }
    }

    if (expose) {
      const service: V1Service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {name},
        spec: {
          type: 'LoadBalancer',
          selector: {app: name},
          ports: [
            {
              port: 80,
              targetPort: containerPort,
            },
          ],
        },
      };

      try {
        await core.readNamespacedService({name, namespace});
        await core.replaceNamespacedService({name, namespace, body: service});
        console.log(`🔄 Updated service ${namespace}/${name}`);
        /* eslint-disable  @typescript-eslint/no-explicit-any */
      } catch (e: any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (e?.code === 404) {
          await core.createNamespacedService({namespace, body: service});
          console.log(`✅ Created service ${namespace}/${name}`);
        } else {
          throw e;
        }
      }
    }
  } finally {
    // Clean up temporary file
    try {
      await fs.unlink(tempFilePath);
    } catch (e) {
      // Ignore errors when cleaning up temp file
      console.warn(`Failed to delete temp kubeconfig file: ${tempFilePath}`, e);
    }
  }
}
