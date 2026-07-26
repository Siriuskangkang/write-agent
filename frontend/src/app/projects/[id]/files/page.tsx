import { redirect } from 'next/navigation';

export default function FilesRedirect({ params }: { params: { id: string } }) {
  redirect(`/projects/${params.id}/materials`);
}
