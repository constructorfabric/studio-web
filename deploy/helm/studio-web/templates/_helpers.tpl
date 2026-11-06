{{- define "studio-web.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "studio-web.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- define "studio-web.labels" -}}
app.kubernetes.io/name: {{ include "studio-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "studio-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "studio-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "studio-web.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ .Values.serviceAccount.name | default (include "studio-web.fullname" .) }}{{ else }}default{{ end -}}
{{- end -}}

{{/* One canonical S3 backend document, consumed by both control and data planes. */}}
{{- define "studio-web.fileStorageS3Backends" -}}
{{- $s3 := .Values.backend.fileStorage.s3 -}}
{{- list (dict "id" .Values.backend.fileStorage.backendId "endpoint" $s3.endpoint "region" $s3.region "bucket" (required "backend.fileStorage.s3.bucket is required when fileStorage is enabled" $s3.bucket) "path_style" $s3.pathStyle) | toJson -}}
{{- end -}}

{{/* The Research emulator's public URL: the portal's hostname and the emulator's path. */}}
{{- define "studio-web.researchEmulatorUrl" -}}
{{- $e := .Values.researchEmulator -}}
{{- if $e.publicUrl -}}
{{- $e.publicUrl | trimSuffix "/" -}}
{{- else -}}
{{- printf "https://%s%s" (required "global.hostname is required for the Research emulator" .Values.global.hostname) ($e.path | trimSuffix "/") -}}
{{- end -}}
{{- end -}}

{{/* The portal callbacks a Research sign-in comes back to. */}}
{{- define "studio-web.researchRedirectUri" -}}
{{- .Values.backend.research.redirectUri | default (printf "https://%s/connections/oauth/callback" .Values.global.hostname) -}}
{{- end -}}
