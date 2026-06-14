export function hostToolsAllowedFromSearch(search: string): boolean {
  const params = new URLSearchParams(search);
  const value = (params.get('tf_host_tools') || '').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no';
}
