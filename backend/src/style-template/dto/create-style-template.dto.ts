import { IsString, IsUUID, IsOptional } from 'class-validator';

export class CreateStyleTemplateDto {
  @IsString()
  name: string;

  @IsUUID()
  projectId: string;

  @IsString()
  @IsOptional()
  filePath?: string;
}
