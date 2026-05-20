import { useQuery } from '@tanstack/react-query';
import { fetchCalendarEventFiles } from '../console-api';
import { parseCalendarEventFile } from '../components/CalendarPane/calendarAdapter';

export function useCalendarEvents() {
  return useQuery({
    queryKey: ['calendar-events'],
    queryFn: async () => {
      const files = await fetchCalendarEventFiles();
      return files.map(parseCalendarEventFile);
    },
    refetchInterval: 30000,
  });
}
