import React from 'react';
import { Composition } from 'remotion';
import { Edit } from './Edit';
import { EditProps, FORMATS, FPS, defaultProps, editLength } from './types';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Edicao"
    component={Edit}
    fps={FPS}
    width={1080}
    height={1920}
    durationInFrames={300}
    defaultProps={defaultProps}
    calculateMetadata={({ props }: { props: EditProps }) => {
      const f = FORMATS[props.format] ?? FORMATS.vertical;
      return {
        width: f.width,
        height: f.height,
        durationInFrames: Math.max(1, Math.round(editLength(props) * FPS)),
      };
    }}
  />
);
