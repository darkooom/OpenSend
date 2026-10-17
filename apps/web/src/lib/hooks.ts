'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { api, errorMessage } from './api';
import type { Me, OrgDetail, Project } from './types';

export function useApi<T>(path: string | null, opts: { refetchInterval?: number } = {}) {
  return useQuery<T>({
    queryKey: ['api', path],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    refetchInterval: opts.refetchInterval,
  });
}

export const useMe = () => useApi<Me>('/me');
export const useOrg = (orgId: string | undefined) =>
  useApi<OrgDetail>(orgId ? `/orgs/${orgId}` : null);
export const useProject = (projectId: string | undefined) =>
  useApi<Project>(projectId ? `/projects/${projectId}` : null);

/** Route params of an environment-scoped page and the matching API base path. */
export function useEnvScope() {
  const params = useParams<{ projectId: string; envId: string }>();
  return {
    projectId: params.projectId,
    envId: params.envId,
    base: `/projects/${params.projectId}/environments/${params.envId}`,
  };
}

/** Mutation with toast feedback and cache invalidation of the given API paths. */
export function useAction<TBody = unknown, TResult = unknown>(
  fn: (body: TBody) => Promise<TResult>,
  opts: {
    success?: string | ((r: TResult) => string);
    error: string;
    invalidate?: Array<string | QueryKey>;
    onSuccess?: (r: TResult) => void;
  },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r) => {
      for (const key of opts.invalidate ?? []) {
        await qc.invalidateQueries({ queryKey: typeof key === 'string' ? ['api', key] : key });
      }
      if (opts.success)
        toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (err) => toast.error(errorMessage(err, opts.error)),
  });
}
