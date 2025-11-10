// exoSksUtil.ts — small helper for Exoscale SKS ↔︎ Kubernetes
//
// Usage example (ESM):
//   import { getKubeConfig, deployImage } from './exoSksUtil.js';
//   const kubeconf = await getKubeConfig({ apiKey, apiSecret, zone, clusterId });
//   await deployImage({ kubeConfigYaml: kubeconf, name: 'hello', image: 'nginx:latest', env: { GREETING: '👋' }, expose: true });
//
// Requires Node ≥ 18, axios ≥ 1, and @kubernetes/client-node ≥ 0.19

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {
  KubeConfig,
  AppsV1Api,
  CoreV1Api,
  V1Deployment,
  V1Service, V1DeploymentSpec, V1PodTemplateSpec, V1Container, V1EnvVar,
} from '@kubernetes/client-node';
import {V1LabelSelector} from "@kubernetes/client-node/dist/gen/models/V1LabelSelector";
import {V1PodSpec} from "@kubernetes/client-node/dist/gen/models/V1PodSpec";
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

    if (!res.data?.kubeconfig) {
      throw new Error('Exoscale response missing "kubeconfig" field');
    }

    // Decode base64 to YAML string
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
  env?: Record<string, string>;
  /** Container port to expose, default 80 */
  containerPort?: number;
  /** When true, creates/updates a LoadBalancer Service */
  expose?: boolean;
}

/**
 * Create or patch a Deployment (and optional Service) in the cluster.
 */
export async function deployImage(opts: DeployImageOptions): Promise<void> {
  const {
    name,
    image,
    namespace = 'default',
    replicas = 1,
    env = {},
    containerPort = 80,
    expose = false,
  } = opts;

  const kubeConfigYaml = await getKubeConfig();
  // Write kubeconfig to temporary file
  const tempFilePath = join(tmpdir(), `kubeconfig-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  await fs.writeFile(tempFilePath, kubeConfigYaml, 'utf-8');

  try {
    // Initialise clients
    const kc = new KubeConfig();
    kc.loadFromFile(tempFilePath);
    const apps = kc.makeApiClient(AppsV1Api);
    const core = kc.makeApiClient(CoreV1Api);

    const selector: V1LabelSelector = {matchLabels: {app: name}};
    const container: V1Container = {
      name,
      image,
      env: Object.entries(env).map(([k, v]) => {
        const envVar: V1EnvVar = {name: k, value: v.toString()};

        return envVar;
      }),
      ports: [{containerPort}],
    };
    const templateSpec: V1PodSpec = {
      containers: [
        container
      ],
    };
    const template: V1PodTemplateSpec = {
      metadata: {labels: {app: name}},
      spec: templateSpec,
    };
    const spec: V1DeploymentSpec = {
      replicas,
      selector,
      template,
    };
    // Build Deployment manifest
    const deployment: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name },
      spec
    };

    // Create or replace Deployment
    try {
      await apps.readNamespacedDeployment({name, namespace});
      const res = await apps.replaceNamespacedDeployment({name, namespace, body: deployment});
      console.log(`🔄 Updated deployment ${namespace}/${name}`);
      console.log(res.status?.conditions);
    } catch (e: any) {
      if (e?.code === 404) {
        await apps.createNamespacedDeployment({namespace, body: deployment});
        console.log(`✅ Created deployment ${namespace}/${name}`);
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
      } catch (e: any) {
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
