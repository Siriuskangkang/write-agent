import { IsString, IsOptional, IsObject, IsArray } from 'class-validator';
import type {
  StyleFeatures,
  PanelAssignment,
  StyleTreeNode,
} from './style-features.dto.js';

export class PanelAssignmentDto implements PanelAssignment {
  @IsArray()
  panel_a: StyleTreeNode[];

  @IsArray()
  panel_b: StyleTreeNode[];

  @IsArray()
  @IsOptional()
  panel_c?: StyleTreeNode[];
}

export class UpdateStyleTemplateDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsObject()
  @IsOptional()
  features?: StyleFeatures;

  @IsObject()
  @IsOptional()
  panel_assignment?: PanelAssignmentDto;
}
