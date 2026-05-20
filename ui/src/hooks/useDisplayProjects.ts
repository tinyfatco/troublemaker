import { useQuery } from '@tanstack/react-query';
import { fetchDisplayProjectManifestFiles } from '../console-api';
import { parseDisplayProjectFile } from '../components/DisplayPane/displayProjectAdapter';

export function useDisplayProjects() {
  return useQuery({
    queryKey: ['display-projects'],
    queryFn: async () => {
      const files = await fetchDisplayProjectManifestFiles();
      const parsed = files.map(parseDisplayProjectFile);
      return {
        parsed,
        projects: parsed.flatMap((file) => file.project ? [file.project] : []),
        errors: parsed.flatMap((file) => file.error ? [{ path: file.path, error: file.error }] : []),
      };
    },
    refetchInterval: 10000,
  });
}
