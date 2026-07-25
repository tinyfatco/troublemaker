import { useQuery } from '@tanstack/react-query';
import { fetchAgentScheduleManifest, fetchAgentSchedulePromptFiles, fetchCalendarEventFiles } from '../console-api';
import { parseAgentScheduleFile, parseCalendarEventFile } from '../components/CalendarPane/calendarAdapter';

export function useCalendarEvents() {
  return useQuery({
    queryKey: ['calendar-events'],
    queryFn: async () => {
      const [calendarFiles, scheduleFiles, manifest] = await Promise.all([
        fetchCalendarEventFiles(),
        fetchAgentSchedulePromptFiles(),
        fetchAgentScheduleManifest().catch(() => null),
      ]);
      const manifestByFile = new Map(
        (manifest?.events ?? []).map((event) => [event.file, event]),
      );

      return [
        ...calendarFiles.map(parseCalendarEventFile),
        ...scheduleFiles.map((file) => parseAgentScheduleFile(
          file,
          manifestByFile.get(file.path) ?? manifestByFile.get(`attention/queue/${file.name}`),
        )),
      ];
    },
    refetchInterval: 30000,
  });
}
