const CASTING_ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'apparent_age_band',
    'gender_expression',
    'regional_visual_context',
    'build_silhouette',
    'hair_grooming',
    'wardrobe_function',
    'visual_medium',
  ],
  properties: {
    apparent_age_band: { type: 'string' },
    gender_expression: { type: 'string' },
    regional_visual_context: { type: 'string' },
    build_silhouette: { type: 'string' },
    hair_grooming: { type: 'string' },
    wardrobe_function: { type: 'string' },
    visual_medium: { type: 'string' },
  },
} as const;

export const VIDEO_DNA_SCHEMA = {
  $id: 'video-dna.v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'source',
    'style_dna',
    'source_roles',
    'beats',
    'preserve_recommendations',
    'replace_recommendations',
    'originality_risks',
    'uncertainties',
    'english',
  ],
  properties: {
    schema_version: { type: 'string', enum: ['video-dna.v1'] },
    source: {
      type: 'object',
      additionalProperties: false,
      required: [
        'duration_seconds',
        'aspect_ratio',
        'language',
        'format_type',
        'one_line_summary',
        'rights_risks',
      ],
      properties: {
        duration_seconds: { type: 'number', minimum: 0.1 },
        aspect_ratio: { type: 'string' },
        language: { type: 'string' },
        format_type: { type: 'string' },
        one_line_summary: { type: 'string' },
        rights_risks: { type: 'array', items: { type: 'string' } },
      },
    },
    style_dna: {
      type: 'object',
      additionalProperties: false,
      required: ['hook_pattern', 'narrative_arc', 'pacing', 'cinematography', 'visual', 'performance', 'audio'],
      properties: {
        hook_pattern: { type: 'string' },
        narrative_arc: { type: 'array', items: { type: 'string' }, minItems: 1 },
        pacing: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'average_shot_seconds', 'energy_curve', 'cut_pattern'],
          properties: {
            description: { type: 'string' },
            average_shot_seconds: { type: 'number', minimum: 0.05 },
            energy_curve: { type: 'array', items: { type: 'string' }, minItems: 1 },
            cut_pattern: { type: 'string' },
          },
        },
        cinematography: {
          type: 'object',
          additionalProperties: false,
          required: ['framing_pattern', 'camera_motion_pattern', 'lens_feel', 'composition_rules', 'continuity_rules'],
          properties: {
            framing_pattern: { type: 'array', items: { type: 'string' } },
            camera_motion_pattern: { type: 'array', items: { type: 'string' } },
            lens_feel: { type: 'string' },
            composition_rules: { type: 'array', items: { type: 'string' } },
            continuity_rules: { type: 'array', items: { type: 'string' } },
          },
        },
        visual: {
          type: 'object',
          additionalProperties: false,
          required: ['medium', 'palette', 'lighting_logic', 'textures', 'atmosphere'],
          properties: {
            medium: { type: 'string' },
            palette: { type: 'array', items: { type: 'string' } },
            lighting_logic: { type: 'string' },
            textures: { type: 'array', items: { type: 'string' } },
            atmosphere: { type: 'string' },
          },
        },
        performance: {
          type: 'object',
          additionalProperties: false,
          required: ['energy', 'gesture_language', 'facial_language', 'blocking_pattern'],
          properties: {
            energy: { type: 'string' },
            gesture_language: { type: 'string' },
            facial_language: { type: 'string' },
            blocking_pattern: { type: 'string' },
          },
        },
        audio: {
          type: 'object',
          additionalProperties: false,
          required: ['dialogue_delivery', 'music_logic', 'sound_effects', 'beat_sync'],
          properties: {
            dialogue_delivery: { type: 'string' },
            music_logic: { type: 'string' },
            sound_effects: { type: 'array', items: { type: 'string' } },
            beat_sync: { type: 'string' },
          },
        },
      },
    },
    source_roles: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'role_id',
          'entity_type',
          'species',
          'body_plan',
          'anthropomorphism_level',
          'casting_envelope',
          'narrative_function',
          'generalized_appearance',
          'silhouette',
          'wardrobe_logic',
          'performance_traits',
          'continuity_anchors',
          'identity_risk',
        ],
        properties: {
          role_id: { type: 'string' },
          entity_type: {
            type: 'string',
            enum: ['human', 'animal', 'anthropomorphic_animal', 'anthropomorphic_object', 'creature', 'robot', 'unknown'],
          },
          species: { type: 'string', description: 'Biological kind, such as domestic cat. Put fur colour, markings, grooming and art style in appearance/casting_envelope, not species.' },
          body_plan: { type: 'string', description: 'Observed anatomical structure: torso, limb count, joints and feet/paws. Not a pose, occupation or action. An animal standing or using tools does not imply a human body or habitual bipedal gait.' },
          anthropomorphism_level: { type: 'string', enum: ['none', 'partial', 'full', 'unknown'] },
          casting_envelope: CASTING_ENVELOPE_SCHEMA,
          narrative_function: { type: 'string' },
          generalized_appearance: { type: 'string' },
          silhouette: { type: 'string' },
          wardrobe_logic: { type: 'string' },
          performance_traits: { type: 'array', items: { type: 'string' } },
          continuity_anchors: { type: 'array', items: { type: 'string' } },
          identity_risk: {
            type: 'string',
            enum: ['none', 'real_person', 'celebrity_or_ip', 'uncertain'],
          },
        },
      },
    },
    beats: {
      type: 'array',
      description: 'Atomic shot timeline. Each item is one uninterrupted camera setup; any cut or reverse angle starts a new item.',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'beat_id',
          'start_seconds',
          'end_seconds',
          'role_ids',
          'narrative_function',
          'visual_action',
          'action_beats',
          // 必填。它是 3D 预演唯一的输入，模型少给一镜，那一镜的预演就是几根叠在原点的柱子——
          // 而管线不会报错，只会安静地出一条跟原片没关系的片子。
          'blocking',
          'environment',
          'props',
          'framing',
          'camera_motion',
          'composition',
          'lighting',
          'color',
          'sound',
          'dialogue',
          'transition_in',
          'continuity_in',
          'continuity_out',
          'confidence',
        ],
        properties: {
          beat_id: { type: 'string', description: 'Unique ID for one uninterrupted source shot.' },
          start_seconds: { type: 'number', minimum: 0 },
          end_seconds: { type: 'number', minimum: 0.01 },
          role_ids: {
            type: 'array',
            description: 'Source role IDs visibly present in this shot.',
            items: { type: 'string' },
          },
          narrative_function: { type: 'string' },
          visual_action: { type: 'string', description: 'One-sentence summary of the whole shot. Put the blow-by-blow detail in action_beats, not here.' },
          action_beats: {
            type: 'array',
            description: 'Every action-reaction exchange inside this one uninterrupted shot, in the order it happens. A shot that is one camera setup can still contain many exchanges; record each one. This is where gaze direction and cause-and-effect must live.',
            items: {
              type: 'object',
              required: ['at_seconds', 'actor_ids', 'action'],
              properties: {
                at_seconds: { type: 'number', minimum: 0, description: 'Absolute seconds from the start of the video, inside this beat range, ascending.' },
                actor_ids: { type: 'array', items: { type: 'string' }, description: 'Who performs this exchange, as ROLE_* ids.' },
                action: { type: 'string', description: 'What the actor physically does in this exchange.' },
                toward_ids: { type: 'array', items: { type: 'string' }, description: 'Who the action is aimed at, looked at, or pointed at, as ROLE_* ids.' },
                reaction: { type: 'string', description: 'How the target responds.' },
                consequence: { type: 'string', description: 'What this exchange causes: who backs down, who gains leverage, how the power balance shifts.' },
              },
            },
          },
          blocking: {
            type: 'object',
            description: 'Where everyone physically is and how the camera sees them. This must be machine-usable: it drives 3D previsualization, 180-degree-line checking, and the staging line in the generation prompt. Never omit it; if unsure of a value pick the closest option rather than dropping the actor.',
            required: ['actors', 'camera'],
            properties: {
              actors: {
                type: 'array',
                description: 'One entry per role visible in this shot. Must cover every id in role_ids.',
                items: {
                  type: 'object',
                  required: ['role_id', 'screen_position', 'depth_layer', 'facing'],
                  properties: {
                    role_id: { type: 'string' },
                    screen_position: {
                      type: 'string',
                      enum: ['left', 'center_left', 'center', 'center_right', 'right', 'offscreen'],
                      description: "Left/right position as the camera sees it, not the character's own left and right.",
                    },
                    depth_layer: {
                      type: 'string',
                      enum: ['foreground', 'midground', 'background'],
                      description: 'Distance band from camera. Determines who occludes whom.',
                    },
                    facing: { type: 'string', description: 'Which way the body faces: toward camera / away from camera / turned left / turned right.' },
                    entry_at: { type: 'number', description: 'Absolute seconds when this role enters frame. Only set it when they are NOT visible at the very start of the shot.' },
                    exit_at: { type: 'number', description: 'Absolute seconds when this role leaves frame, if they do.' },
                  },
                },
              },
              camera: {
                type: 'object',
                required: ['shot_size', 'angle', 'movement', 'screen_direction'],
                properties: {
                  shot_size: { type: 'string', enum: ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS', 'unknown'] },
                  angle: { type: 'string', enum: ['eye_level', 'high', 'low', 'overhead', 'dutch', 'over_shoulder', 'pov', 'unknown'] },
                  movement: { type: 'string', enum: ['static', 'pan', 'tilt', 'dolly_in', 'dolly_out', 'truck', 'crane', 'handheld', 'zoom', 'orbit', 'unknown'] },
                  screen_direction: {
                    type: 'string',
                    enum: ['left_to_right', 'right_to_left', 'toward_camera', 'away_from_camera', 'static', 'unknown'],
                    description: 'Dominant on-screen direction of movement. Used to detect 180-degree-line violations between shots.',
                  },
                  subject_distance_m: { type: 'number', description: 'Rough camera-to-subject distance in metres. Omit rather than guess wildly.' },
                },
              },
            },
          },
          environment: { type: 'string' },
          props: { type: 'array', items: { type: 'string' } },
          framing: { type: 'string', description: 'One framing only; do not describe an internal cut or reverse angle.' },
          camera_motion: { type: 'string', description: 'Motion within this uninterrupted shot only.' },
          composition: { type: 'string' },
          lighting: { type: 'string' },
          color: { type: 'string' },
          sound: { type: 'string' },
          dialogue: {
            type: 'object',
            additionalProperties: false,
            required: ['speaker_role', 'speaker_on_screen', 'source_text', 'semantic_intent', 'delivery', 'approx_characters'],
            properties: {
              speaker_role: { type: 'string' },
              speaker_on_screen: { type: 'boolean', description: 'True only when the speaking performance is visibly on screen; false for off-screen speech, voice-over, or silence.' },
              source_text: { type: 'string' },
              semantic_intent: { type: 'string', description: 'Never empty. Use “无对白” for silence or “意图未识别” when uncertain.' },
              delivery: { type: 'string' },
              approx_characters: { type: 'integer', minimum: 0 },
            },
          },
          transition_in: { type: 'string' },
          continuity_in: { type: 'string' },
          continuity_out: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          timeline_exception: {
            type: 'object',
            description: 'Present only when this shot intentionally starts after a gap or overlaps the previous shot.',
            additionalProperties: false,
            required: ['kind', 'duration_seconds', 'reason'],
            properties: {
              kind: { type: 'string', enum: ['gap', 'overlap'] },
              duration_seconds: { type: 'number', minimum: 0.01 },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    preserve_recommendations: { type: 'array', items: { type: 'string' } },
    replace_recommendations: { type: 'array', items: { type: 'string' } },
    originality_risks: { type: 'array', items: { type: 'string' } },
    uncertainties: { type: 'array', items: { type: 'string' } },
    english: {
      type: 'object',
      description: 'A faithful natural-English rendering of the Chinese fields above, phrased as text-to-video prompt language. Translate only: same facts, no additions, no omissions. Keep ROLE_* ids, numbers and hex colors as written.',
      additionalProperties: false,
      required: ['medium', 'visual', 'performance', 'sound', 'roles', 'beats'],
      properties: {
        medium: { type: 'string', description: 'English of style_dna.visual.medium.' },
        visual: { type: 'string', description: 'One line: medium, palette, lighting logic, textures, atmosphere.' },
        performance: { type: 'string', description: 'One line: energy, gesture language, blocking pattern.' },
        sound: { type: 'string', description: 'One line: music logic and sound effects.' },
        roles: {
          type: 'array',
          description: 'Exactly one entry per source_roles item, same order.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role_id', 'description'],
            properties: {
              role_id: { type: 'string' },
              description: { type: 'string', description: 'Species and body plan; apparent age, gender expression, regional context; appearance; build; silhouette; hair; wardrobe; performance traits; continuity anchors. Skip unknown or invisible traits.' },
            },
          },
        },
        beats: {
          type: 'array',
          description: 'Exactly one entry per beats item, same order and beat_id.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['beat_id', 'action', 'action_beats', 'environment', 'props', 'framing', 'camera_motion', 'lighting', 'sound'],
            properties: {
              beat_id: { type: 'string' },
              action: { type: 'string', description: 'English of visual_action.' },
              action_beats: {
                type: 'array',
                description: 'Same count and order as the action_beats of this beat.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['action', 'reaction', 'consequence'],
                  properties: { action: { type: 'string' }, reaction: { type: 'string' }, consequence: { type: 'string' } },
                },
              },
              environment: { type: 'string' },
              props: { type: 'array', items: { type: 'string' } },
              framing: { type: 'string' },
              camera_motion: { type: 'string' },
              lighting: { type: 'string', description: 'English of lighting plus color.' },
              sound: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

export const COMPILED_CREATIVE_PACK_SCHEMA = {
  $id: 'creative-pack.v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'title',
    'concept_summary',
    'differentiation_log',
    'character_bible',
    'style_lock',
    'beats',
    'prompt_bundle',
    'qa',
    'remix_policy',
    'seedance_asset_map',
  ],
  properties: {
    schema_version: { type: 'string', enum: ['creative-pack.v1'] },
    title: { type: 'string' },
    concept_summary: { type: 'string' },
    differentiation_log: { type: 'array', items: { type: 'string' }, minItems: 1 },
    character_bible: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'character_id',
          'entity_type',
          'species',
          'body_plan',
          'anthropomorphism_level',
          'casting_envelope',
          'role_function',
          'identity_anchors',
          'appearance',
          'wardrobe',
          'palette',
          'performance',
          'continuity_lock',
          'reference_prompts',
        ],
        properties: {
          character_id: { type: 'string' },
          entity_type: {
            type: 'string',
            enum: ['human', 'animal', 'anthropomorphic_animal', 'anthropomorphic_object', 'creature', 'robot', 'unknown'],
          },
          species: { type: 'string' },
          body_plan: { type: 'string' },
          anthropomorphism_level: { type: 'string', enum: ['none', 'partial', 'full', 'unknown'] },
          casting_envelope: CASTING_ENVELOPE_SCHEMA,
          role_function: { type: 'string' },
          identity_anchors: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 6 },
          appearance: { type: 'string' },
          wardrobe: { type: 'string' },
          palette: { type: 'array', items: { type: 'string' } },
          performance: { type: 'string' },
          continuity_lock: { type: 'array', items: { type: 'string' } },
          reference_prompts: {
            type: 'object',
            additionalProperties: false,
            required: ['turnaround_sheet', 'expression_sheet', 'hero_portrait', 'negative_prompt'],
            properties: {
              turnaround_sheet: { type: 'string' },
              expression_sheet: { type: 'string' },
              hero_portrait: { type: 'string' },
              negative_prompt: { type: 'string' },
            },
          },
        },
      },
    },
    style_lock: {
      type: 'object',
      additionalProperties: false,
      required: ['pacing', 'camera', 'visual', 'performance', 'sound', 'negative_constraints'],
      properties: {
        pacing: { type: 'string' },
        camera: { type: 'string' },
        visual: { type: 'string' },
        performance: { type: 'string' },
        sound: { type: 'string' },
        negative_constraints: { type: 'array', items: { type: 'string' } },
      },
    },
    beats: {
      type: 'array',
      description: 'Atomic shot timeline. Each item is one uninterrupted camera setup; any cut or reverse angle starts a new item.',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'beat_id',
          'start_seconds',
          'end_seconds',
          'story_function',
          'character_ids',
          'action',
          'performance',
          'environment',
          'props',
          'framing',
          'camera_motion',
          'lighting',
          'continuity',
          'dialogue',
          'sound',
          'video_prompt',
        ],
        properties: {
          beat_id: { type: 'string', description: 'Unique ID for one uninterrupted generated shot.' },
          start_seconds: { type: 'number', minimum: 0 },
          end_seconds: { type: 'number', minimum: 0.01 },
          story_function: { type: 'string' },
          character_ids: { type: 'array', items: { type: 'string' } },
          action: { type: 'string' },
          performance: { type: 'string' },
          environment: { type: 'string' },
          props: { type: 'array', items: { type: 'string' } },
          framing: { type: 'string', description: 'One framing only; do not describe an internal cut or reverse angle.' },
          camera_motion: { type: 'string', description: 'Motion within this uninterrupted shot only.' },
          lighting: { type: 'string' },
          continuity: { type: 'string' },
          dialogue: {
            type: 'string',
            description: 'Exact replacement dialogue. Prefix every spoken line with its CHAR_* speaker ID when multiple characters are present.',
          },
          dialogue_speaker_ids: {
            type: 'array',
            description: 'Character IDs that speak in this shot, in first-speaking order.',
            items: { type: 'string' },
          },
          sound: { type: 'string' },
          video_prompt: { type: 'string' },
          timeline_exception: {
            type: 'object',
            description: 'Present only when this shot intentionally starts after a gap or overlaps the previous shot.',
            additionalProperties: false,
            required: ['kind', 'duration_seconds', 'reason'],
            properties: {
              kind: { type: 'string', enum: ['gap', 'overlap'] },
              duration_seconds: { type: 'number', minimum: 0.01 },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    prompt_bundle: {
      type: 'object',
      additionalProperties: false,
      required: [
        'generic_master',
        'target_model',
        'target_prompt',
        'negative_prompt',
        'first_frame_prompt',
        'last_frame_prompt',
      ],
      properties: {
        generic_master: { type: 'string' },
        target_model: { type: 'string' },
        target_prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
        first_frame_prompt: { type: 'string' },
        last_frame_prompt: { type: 'string' },
      },
    },
    qa: {
      type: 'object',
      additionalProperties: false,
      required: [
        'timing_valid',
        'variables_applied',
        'originality_pass',
        'source_identity_leakage',
        'source_dialogue_leakage',
        'notes',
      ],
      properties: {
        timing_valid: { type: 'boolean' },
        variables_applied: { type: 'boolean' },
        originality_pass: { type: 'boolean' },
        source_identity_leakage: { type: 'boolean' },
        source_dialogue_leakage: { type: 'boolean' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    remix_policy: {
      type: 'object',
      description: 'Compiler-added resolved remix policy. Not requested from the model draft.',
      additionalProperties: false,
      required: ['requested_mode', 'effective_mode', 'source_rights_scope'],
      properties: {
        requested_mode: { type: 'string', enum: ['character_swap', 'light_remix', 'full_original'] },
        effective_mode: { type: 'string', enum: ['character_swap', 'light_remix', 'full_original'] },
        source_rights_scope: { type: 'string', enum: ['owned_or_authorized', 'third_party_reference'] },
      },
    },
    seedance_asset_map: {
      type: 'object',
      description: 'Compiler-added Seedance reference mapping. Not requested from the model draft.',
      additionalProperties: false,
      required: ['schema_version', 'bindings', 'runs', 'usage_note'],
      properties: {
        schema_version: { type: 'string', enum: ['seedance-assets.v1'] },
        bindings: {
          type: 'array',
          minItems: 2,
          items: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['slot', 'kind', 'source_role_id', 'character_id', 'candidate_id', 'asset_id', 'reference_prompt', 'approved', 'instruction'],
                properties: {
                  slot: { type: 'string' },
                  kind: { type: 'string', enum: ['character_reference'] },
                  source_role_id: { type: 'string' },
                  character_id: { type: 'string' },
                  candidate_id: { type: 'string' },
                  asset_id: { type: 'string' },
                  reference_prompt: { type: 'string' },
                  approved: { type: 'boolean', enum: [true] },
                  instruction: { type: 'string' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['slot', 'kind', 'instruction'],
                properties: {
                  slot: { type: 'string' },
                  kind: {
                    type: 'string',
                    enum: [
                      'source_video_reference',
                      'dialogue_audio_reference',
                      'music_audio_reference',
                      'ambience_audio_reference',
                    ],
                  },
                  instruction: { type: 'string' },
                },
              },
            ],
          },
        },
        runs: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'run_id',
              'source_start_seconds',
              'source_end_seconds',
              'duration_seconds',
              'beat_ids',
              'target_prompt',
              'assembly_instruction',
            ],
            properties: {
              run_id: { type: 'string' },
              source_start_seconds: { type: 'number', minimum: 0 },
              source_end_seconds: { type: 'number', minimum: 0.01 },
              duration_seconds: { type: 'number', minimum: 0.01, maximum: 30 },
              beat_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
              target_prompt: { type: 'string' },
              assembly_instruction: { type: 'string' },
            },
          },
        },
        usage_note: { type: 'string' },
      },
    },
  },
} as const;

export const CREATIVE_DRAFT_SCHEMA = {
  $id: 'creative-draft.v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'title',
    'concept_summary',
    'differentiation_log',
    'style_lock',
    'beats',
    'qa',
  ],
  properties: {
    schema_version: { type: 'string', enum: ['creative-draft.v1'] },
    title: COMPILED_CREATIVE_PACK_SCHEMA.properties.title,
    concept_summary: COMPILED_CREATIVE_PACK_SCHEMA.properties.concept_summary,
    differentiation_log: COMPILED_CREATIVE_PACK_SCHEMA.properties.differentiation_log,
    style_lock: COMPILED_CREATIVE_PACK_SCHEMA.properties.style_lock,
    beats: {
      type: 'array',
      description: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.description,
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'beat_id',
          'start_seconds',
          'end_seconds',
          'story_function',
          'character_ids',
          'action',
          'performance',
          'environment',
          'props',
          'framing',
          'camera_motion',
          'lighting',
          'continuity',
          'dialogue',
          'sound',
        ],
        properties: {
          beat_id: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.beat_id,
          start_seconds: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.start_seconds,
          end_seconds: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.end_seconds,
          story_function: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.story_function,
          character_ids: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.character_ids,
          action: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.action,
          performance: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.performance,
          environment: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.environment,
          props: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.props,
          framing: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.framing,
          camera_motion: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.camera_motion,
          lighting: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.lighting,
          continuity: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.continuity,
          dialogue: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.dialogue,
          dialogue_speaker_ids: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.dialogue_speaker_ids,
          sound: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.sound,
          timeline_exception: COMPILED_CREATIVE_PACK_SCHEMA.properties.beats.items.properties.timeline_exception,
        },
      },
    },
    qa: COMPILED_CREATIVE_PACK_SCHEMA.properties.qa,
  },
} as const;

export const CREATIVE_PACK_SCHEMA = COMPILED_CREATIVE_PACK_SCHEMA;

export const CHARACTER_PROPOSALS_SCHEMA = {
  $id: 'character-proposals.v1',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'role_sets'],
  properties: {
    schema_version: { type: 'string', enum: ['character-proposals.v1'] },
    role_sets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_role_id', 'role_function', 'candidates'],
        properties: {
          source_role_id: { type: 'string' },
          role_function: { type: 'string' },
          candidates: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'candidate_id',
                'design_mode',
                'source_role_id',
                'character_id',
                'entity_type',
                'species',
                'body_plan',
                'anthropomorphism_level',
                'casting_envelope',
                'design_name',
                'design_rationale',
                'role_function',
                'identity_anchors',
                'appearance',
                'wardrobe',
                'palette',
                'performance',
                'continuity_lock',
                'reference_prompts',
                'reference_image_prompt',
              ],
              properties: {
                candidate_id: { type: 'string' },
                design_mode: { type: 'string', enum: ['source_match', 'style_variant'] },
                source_role_id: { type: 'string' },
                character_id: { type: 'string' },
                entity_type: {
                  type: 'string',
                  enum: ['human', 'animal', 'anthropomorphic_animal', 'anthropomorphic_object', 'creature', 'robot', 'unknown'],
                },
                species: { type: 'string' },
                body_plan: { type: 'string' },
                anthropomorphism_level: { type: 'string', enum: ['none', 'partial', 'full', 'unknown'] },
                casting_envelope: CASTING_ENVELOPE_SCHEMA,
                design_name: { type: 'string' },
                design_rationale: { type: 'string' },
                role_function: { type: 'string' },
                identity_anchors: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'string' } },
                appearance: { type: 'string' },
                wardrobe: { type: 'string' },
                palette: { type: 'array', minItems: 2, items: { type: 'string' } },
                performance: { type: 'string' },
                continuity_lock: { type: 'array', minItems: 3, items: { type: 'string' } },
                reference_prompts: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['turnaround_sheet', 'expression_sheet', 'hero_portrait', 'negative_prompt'],
                  properties: {
                    turnaround_sheet: { type: 'string' },
                    expression_sheet: { type: 'string' },
                    hero_portrait: { type: 'string' },
                    negative_prompt: { type: 'string' },
                  },
                },
                reference_image_prompt: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Gemini 的 responseSchema 走 OpenAPI 3.0 子集，只认下面这些关键字。
 * additionalProperties 这类纯 JSON Schema 关键字留在里面会让整份 schema 被判无效。
 */
const RESPONSE_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'example', 'default',
  'properties', 'required', 'propertyOrdering', 'items', 'anyOf',
  'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

const responseSchemaCache = new WeakMap<object, unknown>();

/**
 * 把内部的严格 JSON Schema 转成 Gemini 的 responseSchema 能收的形状。
 *
 * 为什么必须用 responseSchema 而不是 responseJsonSchema：中转（HeyRoute）只转发 responseSchema，
 * responseJsonSchema 会被整个丢掉，模型随即自由发挥——2026-09-09 实测返回的是它自己编的
 * dna_version / metadata / shots 格式，还裹着 ```json 围栏，到解析层才报「不是 video-dna.v1 数据」。
 * responseSchema 在 Google 原生接口上同样支持，所以统一走这一条，不做分支。
 */
export function toResponseSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => toResponseSchema(item)) as T;
  if (!schema || typeof schema !== 'object') return schema;
  const cached = responseSchemaCache.get(schema as object);
  if (cached) return cached as T;
  const converted = Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => RESPONSE_SCHEMA_KEYS.has(key))
      .map(([key, value]) => [key, key === 'properties'
        // properties 下面是字段名，不是 schema 关键字，不能拿白名单去筛。
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, toResponseSchema(child)]))
        : toResponseSchema(value)]),
  ) as T;
  responseSchemaCache.set(schema as object, converted);
  return converted;
}

/**
 * 候选数由用户选（2–6）。schema 里写死区间给出上下限，具体那次要几套由这个函数钉死，
 * 提示词和 schema 必须说同一个数——两边不一致时模型会按 schema 出，用户选的就白选了。
 */
export function characterProposalsSchema(count: number) {
  const exact = Math.max(2, Math.min(6, Math.floor(count)));
  const base = CHARACTER_PROPOSALS_SCHEMA;
  const roleSets = base.properties.role_sets;
  return {
    ...base,
    properties: {
      ...base.properties,
      role_sets: {
        ...roleSets,
        items: {
          ...roleSets.items,
          properties: {
            ...roleSets.items.properties,
            candidates: { ...roleSets.items.properties.candidates, minItems: exact, maxItems: exact },
          },
        },
      },
    },
  };
}
